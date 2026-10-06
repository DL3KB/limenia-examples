"""FastAPI backend of an app that uses Limenia for reports and moderation.

Run with: uvicorn app.main:create_app --factory --reload
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from . import webhooks
from .limenia import LimeniaClient, device_request_hash
from .signature import SignatureError, verify_signature

log = logging.getLogger("limenia.example")

MAX_WEBHOOK_BODY = 1 << 20
REQUEST_HASH_TTL_SECONDS = 600  # Limenia rejects device tokens older than 15 minutes

# Fields the app may set in a report. `source` and `reporter` are set here.
REPORT_FIELDS = ("reasonCategory", "reasonText", "subject", "content", "externalReportId")


@dataclass
class Config:
    api_key: str
    webhook_secrets: list[str] = field(default_factory=list)
    base_url: str = "https://app.limenia.eu"

    @classmethod
    def from_env(cls) -> Config:
        api_key = os.environ.get("LIMENIA_API_KEY", "")
        current = os.environ.get("LIMENIA_WEBHOOK_SECRET", "")
        if not api_key or not current:
            raise RuntimeError("LIMENIA_API_KEY and LIMENIA_WEBHOOK_SECRET are required")
        previous = os.environ.get("LIMENIA_WEBHOOK_SECRET_PREVIOUS", "")
        return cls(
            api_key=api_key,
            webhook_secrets=[s for s in (current, previous) if s],
            base_url=os.environ.get("LIMENIA_BASE_URL") or cls.base_url,
        )


def current_user(x_user_id: str | None = Header(default=None)) -> str:
    """REPLACE WITH YOUR LOGIN. This stub trusts an `X-User-Id` header so the
    example runs without an auth system. Return the stable internal ID of the
    signed-in user (the same ID you use as `externalUserId` in reports)."""
    if not x_user_id:
        raise HTTPException(status_code=401, detail="not signed in")
    return x_user_id


def problem(status: int, code: str, detail: str) -> JSONResponse:
    return JSONResponse(
        {"type": "about:blank", "title": detail, "status": status, "code": code},
        status_code=status,
        media_type="application/problem+json",
    )


def forward(upstream: httpx.Response) -> Response:
    """Pass Limenia's status, body (JSON or problem+json) and Retry-After on."""
    headers = {}
    if "Retry-After" in upstream.headers:
        headers["Retry-After"] = upstream.headers["Retry-After"]
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("Content-Type"),
        headers=headers,
    )


def create_app(
    config: Config | None = None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    sleep: Callable[[float], Awaitable[None]] | None = None,
) -> FastAPI:
    config = config or Config.from_env()
    client_args: dict[str, Any] = {"transport": transport}
    if sleep is not None:
        client_args["sleep"] = sleep
    limenia = LimeniaClient(config.base_url, config.api_key, **client_args)
    processed = webhooks.ProcessedEvents()
    # user ID -> (requestHash, expires at). In memory for this example; use
    # your cache or database in production.
    pending_hashes: dict[str, tuple[str, float]] = {}

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        await limenia.aclose()

    app = FastAPI(title="Limenia example backend", lifespan=lifespan)

    @app.post("/reports")
    async def create_report(
        request: Request,
        user_id: str = Depends(current_user),
        idempotency_key: str | None = Header(default=None),
    ) -> Response:
        try:
            body = await request.json()
        except ValueError:
            return problem(400, "bad_request", "Body must be JSON")
        if not isinstance(body, dict):
            return problem(400, "bad_request", "Body must be a JSON object")

        report = {k: body[k] for k in REPORT_FIELDS if k in body}
        report["source"] = "user"
        report["reporter"] = {"externalUserId": user_id}  # from the login, never from the body

        # The app should create one key per report and resend it on every
        # retry. Without one, generate it here; it then only covers our retries.
        key = idempotency_key or f"report-{uuid.uuid4()}"
        try:
            upstream = await limenia.request(
                "POST", "/v1/reports", json=report, headers={"Idempotency-Key": key}
            )
        except httpx.TransportError:
            return problem(502, "limenia_unreachable", "Limenia could not be reached")
        response = forward(upstream)
        response.headers["Idempotency-Key"] = key
        return response

    @app.get("/me/moderation-status")
    async def my_status(user_id: str = Depends(current_user)) -> Response:
        try:
            upstream = await limenia.request(
                "GET", f"/v1/subjects/{quote(user_id, safe='')}/status"
            )
        except httpx.TransportError:
            return problem(502, "limenia_unreachable", "Limenia could not be reached")
        return forward(upstream)

    @app.post("/devices/request-hash")
    async def device_request_hash_endpoint(user_id: str = Depends(current_user)) -> dict[str, str]:
        """Step 1 of a device check: the app passes this hash to
        LimeniaDevice.requestToken (Flutter plugin limenia_device)."""
        request_hash = device_request_hash(user_id, secrets.token_urlsafe(24))
        pending_hashes[user_id] = (request_hash, time.time() + REQUEST_HASH_TTL_SECONDS)
        return {"requestHash": request_hash}

    @app.post("/devices/check")
    async def device_check(request: Request, user_id: str = Depends(current_user)) -> Response:
        """Step 2: the app sends {platform, token[, event, environment]}.
        Call this at registration and at every login, also for a banned
        account before you reject the login."""
        try:
            body = await request.json()
        except ValueError:
            return problem(400, "bad_request", "Body must be JSON")
        if not isinstance(body, dict):
            return problem(400, "bad_request", "Body must be a JSON object")

        check: dict[str, Any] = {
            "externalUserId": user_id,
            "platform": body.get("platform"),
            "token": body.get("token"),
        }
        if body.get("event"):
            check["event"] = body["event"]  # registration, login, report or other
        if body.get("environment"):
            check["environment"] = body["environment"]  # iOS debug builds: "development"
        pending = pending_hashes.pop(user_id, None)
        if check["platform"] == "android":
            if pending is None or pending[1] < time.time():
                return problem(400, "request_hash_missing", "Request a hash first")
            check["requestHash"] = pending[0]

        # No retries: a device token is single-use.
        try:
            upstream = await limenia.request("POST", "/v1/devices/check", json=check, retry=False)
        except httpx.TransportError:
            upstream = None
        if upstream is None or upstream.status_code == 429 or upstream.status_code >= 500:
            # Fail open. Never reject a login because the check could not run.
            return JSONResponse({"status": "unevaluated", "deviceFlag": "unknown"})
        # 200: see the README for how to use status, deviceFlag and subject.status.
        return forward(upstream)

    @app.post("/limenia/webhook")
    async def limenia_webhook(request: Request) -> Response:
        raw_body = await request.body()  # the raw bytes, exactly as signed
        if len(raw_body) > MAX_WEBHOOK_BODY:
            return Response(status_code=413)
        try:
            verify_signature(request.headers.get("Limenia-Signature"), raw_body, config.webhook_secrets)
        except SignatureError as err:
            return JSONResponse({"code": err.code}, status_code=401)

        try:
            event = json.loads(raw_body)
        except ValueError:
            return JSONResponse({"code": "invalid_body"}, status_code=400)
        if not isinstance(event, dict) or not isinstance(event.get("id"), str):
            return JSONResponse({"code": "invalid_body"}, status_code=400)

        if processed.seen(event["id"]):
            return Response(status_code=204)  # duplicate: acknowledge only
        try:
            await webhooks.handle_event(event)
        except Exception:
            log.exception("limenia event failed", extra={"event_id": event["id"]})
            return Response(status_code=503)  # Limenia retries later
        processed.add(event["id"])
        return Response(status_code=204)

    return app
