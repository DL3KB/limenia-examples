import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from app import webhooks
from app.main import Config, create_app
from app.signature import sign

SECRET = "whsec_test"


class FakeLimenia:
    """Records requests and answers with queued responses."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


@pytest.fixture
def make_client():
    def make(*responses):
        fake = FakeLimenia(*responses)
        waits: list[float] = []

        async def sleep(seconds: float) -> None:
            waits.append(seconds)

        app = create_app(
            Config(api_key="lm_test", webhook_secrets=["whsec_new", SECRET]),
            transport=httpx.MockTransport(fake),
            sleep=sleep,
        )
        return TestClient(app), fake, waits

    return make


def created(**extra):
    return httpx.Response(201, json={"reportId": "r1", "caseId": "c1", "caseCreated": True}, **extra)


def test_report_sets_reporter_and_passes_key(make_client):
    client, fake, _ = make_client(created())
    body = {
        "reasonCategory": "spam",
        "reporter": {"externalUserId": "someone_else"},
        "source": "system",
        "content": {"externalContentId": "comment_1", "contentType": "comment"},
    }
    response = client.post("/reports", json=body, headers={"X-User-Id": "u_1", "Idempotency-Key": "report-42"})

    assert response.status_code == 201
    sent = fake.requests[0]
    assert sent.url.path == "/v1/reports"
    assert sent.headers["Authorization"] == "Bearer lm_test"
    assert sent.headers["Idempotency-Key"] == "report-42"
    payload = json.loads(sent.content)
    assert payload["reporter"] == {"externalUserId": "u_1"}
    assert payload["source"] == "user"


def test_report_requires_login(make_client):
    client, fake, _ = make_client()
    assert client.post("/reports", json={}).status_code == 401
    assert fake.requests == []


def test_report_retries_with_same_key_and_respects_retry_after(make_client):
    client, fake, waits = make_client(
        httpx.ConnectError("boom"),
        httpx.Response(429, headers={"Retry-After": "5"}, json={"code": "rate_limited"}),
        httpx.Response(503),
        created(),
    )
    response = client.post("/reports", json={"reasonCategory": "spam"}, headers={"X-User-Id": "u_1"})

    assert response.status_code == 201
    assert waits == [1, 5, 4]
    keys = {r.headers["Idempotency-Key"] for r in fake.requests}
    assert len(keys) == 1 and keys.pop().startswith("report-")


def test_report_forwards_problem_and_retry_after(make_client):
    problem = {"type": "about:blank", "title": "Too Many Requests", "status": 429, "code": "rate_limited"}
    client, fake, waits = make_client(
        httpx.Response(429, headers={"Retry-After": "120", "Content-Type": "application/problem+json"}, json=problem)
    )
    response = client.post("/reports", json={"reasonCategory": "spam"}, headers={"X-User-Id": "u_1"})

    assert response.status_code == 429
    assert response.headers["Retry-After"] == "120"
    assert response.headers["Content-Type"] == "application/problem+json"
    assert response.json()["code"] == "rate_limited"
    assert waits == []


def test_report_does_not_retry_4xx(make_client):
    client, fake, _ = make_client(httpx.Response(400, json={"code": "validation_failed"}))
    response = client.post("/reports", json={"reasonCategory": "x"}, headers={"X-User-Id": "u_1"})
    assert response.status_code == 400
    assert len(fake.requests) == 1


def test_status_encodes_the_user_id(make_client):
    client, fake, _ = make_client(httpx.Response(200, json={"externalUserId": "a/b c", "status": "active"}))
    response = client.get("/me/moderation-status", headers={"X-User-Id": "a/b c"})
    assert response.status_code == 200
    assert fake.requests[0].url.raw_path == b"/v1/subjects/a%2Fb%20c/status"


def test_device_check_forwards_token_and_hash(make_client):
    result = {"checkId": "k1", "platform": "android", "status": "evaluated", "deviceFlag": "none",
              "deviceAction": "none", "subject": {"externalUserId": "u_1", "status": "active"}, "test": False}
    client, fake, _ = make_client(httpx.Response(200, json=result))
    headers = {"X-User-Id": "u_1"}
    request_hash = client.post("/devices/request-hash", headers=headers).json()["requestHash"]

    response = client.post("/devices/check", json={"platform": "android", "token": "tok", "event": "login"}, headers=headers)

    assert response.json() == result
    assert json.loads(fake.requests[0].content) == {
        "externalUserId": "u_1", "platform": "android", "token": "tok", "event": "login", "requestHash": request_hash,
    }


def test_device_check_fails_open_without_retry(make_client):
    client, fake, _ = make_client(httpx.Response(503))
    response = client.post("/devices/check", json={"platform": "ios", "token": "tok"}, headers={"X-User-Id": "u_1"})
    assert response.json() == {"status": "unevaluated", "deviceFlag": "unknown"}
    assert len(fake.requests) == 1


def post_event(client, event, secret=SECRET):
    body = json.dumps(event).encode()
    return client.post(
        "/limenia/webhook",
        content=body,
        headers={"Limenia-Signature": sign(body, secret, int(time.time())), "Content-Type": "application/json"},
    )


def decision_event(event_id, **decision):
    return {
        "id": event_id, "type": "decision.created", "createdAt": "2026-10-01T10:00:00Z",
        "app": {"id": "a1", "slug": "demo"},
        "decision": {"id": "d1", "policies": [], "decidedAt": "2026-10-01T10:00:00Z",
                     "statementOfReasons": {"locale": "en", "text": "..."}, **decision},
    }


def test_webhook_applies_decision_once(make_client, monkeypatch):
    calls = []
    monkeypatch.setattr(webhooks, "ban_user", lambda user_id: calls.append(user_id))
    client, _, _ = make_client()
    event = decision_event("evt_1", action="ban_user", subject={"externalUserId": "u_9"})

    assert post_event(client, event).status_code == 204
    assert post_event(client, event).status_code == 204  # redelivery
    assert calls == ["u_9"]


def test_webhook_review_decision_never_touches_the_account(make_client, monkeypatch):
    account_calls = []
    for name in ("restore_account", "ban_user", "suspend_user", "warn_user", "set_account_status"):
        monkeypatch.setattr(webhooks, name, lambda *args, n=name: account_calls.append(n))
    rejected = []
    monkeypatch.setattr(webhooks, "reject_submission", lambda content_id: rejected.append(content_id))
    client, _, _ = make_client()

    post_event(client, decision_event("evt_2", action="reject_submission", reviewId="rv1",
                                      content={"externalContentId": "photo_1"}, subject={"externalUserId": "u_9"}))
    post_event(client, decision_event("evt_3", action="restore", restoreScope="content", reviewId="rv1",
                                      content={"externalContentId": "photo_1"}, subject={"externalUserId": "u_9"}))

    assert rejected == ["photo_1"]
    assert account_calls == []


def test_webhook_rejects_bad_signature(make_client):
    client, _, _ = make_client()
    assert post_event(client, {"id": "evt_4", "type": "test.ping"}, secret="whsec_wrong").status_code == 401


def test_webhook_acknowledges_unknown_types(make_client):
    client, _, _ = make_client()
    assert post_event(client, {"id": "evt_5", "type": "something.new"}).status_code == 204


def test_webhook_asks_for_retry_when_handling_fails(make_client, monkeypatch):
    def fail(_):
        raise RuntimeError("database down")

    monkeypatch.setattr(webhooks, "notify_reporters", fail)
    client, _, _ = make_client()
    event = {"id": "evt_6", "type": "reports.resolved", "reports": {"decisionId": "d1", "items": []}}
    assert post_event(client, event).status_code == 503
    monkeypatch.setattr(webhooks, "notify_reporters", lambda _: None)
    assert post_event(client, event).status_code == 204  # not marked as processed before
