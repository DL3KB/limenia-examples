"""A tiny HTTP client for the Limenia ingest API (`/v1`), built on httpx."""

from __future__ import annotations

import asyncio
import base64
import hashlib
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

MAX_ATTEMPTS = 5  # waits 1, 2, 4 and 8 seconds between attempts
MAX_WAIT_SECONDS = 30  # a longer Retry-After is passed on to the caller instead


class LimeniaClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}"},
            # Limenia scales to zero; the first request after a pause can be slow.
            timeout=30.0,
            transport=transport,
        )
        self._sleep = sleep

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        headers: dict[str, str] | None = None,
        retry: bool = True,
    ) -> httpx.Response:
        """Send a request. With `retry`, network errors, 429 and 5xx are retried
        with exponential backoff, waiting at least `Retry-After`. The last
        response is returned as it is; a network error on the last attempt is
        raised (httpx.TransportError)."""
        backoff = 1.0
        for attempt in range(1, MAX_ATTEMPTS + 1):
            last = not retry or attempt == MAX_ATTEMPTS
            try:
                response = await self._http.request(method, path, json=json, headers=headers)
            except httpx.TransportError:
                if last:
                    raise
                await self._sleep(backoff)
                backoff *= 2
                continue

            if last or (response.status_code != 429 and response.status_code < 500):
                return response
            wait = max(backoff, retry_after_seconds(response))
            if wait > MAX_WAIT_SECONDS:
                return response
            await self._sleep(wait)
            backoff *= 2
        raise AssertionError("unreachable")

    async def aclose(self) -> None:
        await self._http.aclose()


def retry_after_seconds(response: httpx.Response) -> float:
    try:
        return max(0.0, float(response.headers.get("Retry-After", "0")))
    except ValueError:
        return 0.0


def device_request_hash(external_user_id: str, nonce: str) -> str:
    """base64url(SHA-256("limenia:" + externalUserId + ":" + nonce)), no padding."""
    digest = hashlib.sha256(f"limenia:{external_user_id}:{nonce}".encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
