# Limenia with Go

A small backend for an app that uses Limenia, with the Go standard library only (`net/http`, `crypto/hmac`, `encoding/json`). No SDK, no dependencies.

| Endpoint of this backend | What it does | Limenia API |
|---|---|---|
| `POST /reports` | A signed-in user reports content or another user | `POST /v1/reports` |
| `GET /me/moderation-status` | The signed-in user's own moderation status | `GET /v1/subjects/{id}/status` |
| `POST /devices/request-hash` | Step 1 of a device check: a request hash for the app | none |
| `POST /devices/check` | Step 2: forwards the device token from the app | `POST /v1/devices/check` |
| `POST /limenia/webhook` | Receives signed webhook events from Limenia | none (Limenia calls you) |

The app never talks to Limenia directly and never sees the API key.

## Files

- `main.go`: configuration and server start
- `server.go`: routes, the login stub, reports, status and device check
- `limenia.go`: HTTP client with retries, and the device request hash
- `signature.go`: verification of `Limenia-Signature`
- `webhook.go`: webhook handler, event types and what to do per event
- `actions.go`: placeholders for your own code (`TODO`)
- `*_test.go`: tests, no network needed

## Setup

Requires Go 1.22 or later.

```sh
cp .env.example .env   # then fill in your values
```

| Variable | Required | Meaning |
|---|---|---|
| `LIMENIA_BASE_URL` | no | Address of Limenia without `/v1`, default `https://app.limenia.eu` |
| `LIMENIA_API_KEY` | yes | API key of your app, from the Limenia dashboard |
| `LIMENIA_WEBHOOK_SECRET` | yes | Webhook secret of your app |
| `LIMENIA_WEBHOOK_SECRET_PREVIOUS` | no | The previous secret, only while you rotate it |
| `PORT` | no | Port of this server, default `8080` |

## Run

```sh
set -a; . ./.env; set +a
go run .
```

Your webhook URL must be public and use `https`, for example through a tunnel during development. Enter `https://<your host>/limenia/webhook` in the dashboard.

## Test

```sh
go test ./...
```

## Try it

The login is a stub: it trusts the header `X-User-Id`. **Replace `currentUser` in `server.go` with your own login** before you deploy anything.

Report a comment. Send the same `Idempotency-Key` again when you retry the same report:

```sh
curl -i -X POST localhost:8080/reports \
  -H 'X-User-Id: u_829' \
  -H 'Idempotency-Key: report-7f3c9a' \
  -H 'Content-Type: application/json' \
  -d '{
    "reasonCategory": "harassment_hate",
    "reasonText": "Insults me in every comment",
    "subject": { "externalUserId": "u_112", "displayName": "maxi_99" },
    "content": { "externalContentId": "comment_5521", "contentType": "comment", "text": "The reported comment" }
  }'
```

Your own status:

```sh
curl -i localhost:8080/me/moderation-status -H 'X-User-Id: u_112'
```

A device check. In a Flutter app the token comes from the plugin [`limenia_device`](https://github.com/DL3KB/limenia-flutter) (`LimeniaDevice.requestToken(requestHash: ...)`). With the test mode of the device connector you can use test tokens:

```sh
curl -s -X POST localhost:8080/devices/request-hash -H 'X-User-Id: u_112'
curl -i -X POST localhost:8080/devices/check \
  -H 'X-User-Id: u_112' -H 'Content-Type: application/json' \
  -d '{"platform": "test", "token": "test:device-1", "event": "login"}'
```

A signed test webhook (secret `whsec_test` here; start the server with the same secret):

```sh
BODY='{"id":"evt_local_1","type":"test.ping","createdAt":"2026-10-01T10:00:00Z","app":{"id":"app_1","slug":"demo"}}'
T=$(date +%s)
SIG=$(printf '%s' "$T.$BODY" | openssl dgst -sha256 -hmac whsec_test -hex | sed 's/^.* //')
curl -i -X POST localhost:8080/limenia/webhook \
  -H "Limenia-Signature: t=$T,v1=$SIG" -H 'Content-Type: application/json' --data "$BODY"
```

## How it works

### Reports

- `source` is always `user`, and `reporter.externalUserId` comes from the login, never from the request body. The other fields (`reasonCategory`, `reasonText`, `goodFaith`, `subject`, `content`, `externalReportId`) are passed on. In a real app, load `subject` and `content` from your own database by ID instead of trusting what the app sends.
- `Idempotency-Key` is required by Limenia. The app should create one key per report, keep it, and resend it with every retry of that report. Without a key, this backend generates one; it then only protects its own retries. The key is returned in the `Idempotency-Key` response header.
- Network errors, `429` and `5xx` are retried up to 5 times with backoff of 1, 2, 4 and 8 seconds, waiting at least `Retry-After`. A `Retry-After` above 30 seconds is passed on to the app instead. Other `4xx` are never retried.
- Limenia's status, body (`application/problem+json` for errors) and `Retry-After` are passed on unchanged. If the report still fails, queue it and send it again within 24 hours with the same key.

### Status

`GET /me/moderation-status` only ever asks for the signed-in user. The ID is escaped with `url.PathEscape`, so IDs with `/` work. Use it as a fallback, for example at login, not on every request.

### Device check

1. The app asks `POST /devices/request-hash`. The backend picks a random nonce and returns `base64url(SHA-256("limenia:" + userId + ":" + nonce))` without padding. It keeps the hash for 10 minutes.
2. The app gets a token with that hash and sends `{platform, token, event, environment}` to `POST /devices/check`. `event` is `registration`, `login`, `report` or `other`; `environment` is only for iOS debug builds (`development`).
3. The backend forwards token, user and (Android only) the hash to Limenia, once: a token is single-use, so it is never retried. On a network error, `429` or `5xx` it answers `{"status": "unevaluated", "deviceFlag": "unknown"}` (fail open).

Check at registration and at every login, also for a banned or suspended account before you reject its login. Suggested use of the result:

- `subject.status` is `banned` or `suspended`: reject the login as you already do.
- `deviceFlag: banned` at a registration: do not reject automatically; restrict the new account until a moderator has decided, or let a Limenia rule open a case.
- `unevaluated` and `unknown` are never a reason to reject anyone.

### Webhooks

- The signature is checked on the raw body (`io.ReadAll(r.Body)`), never on decoded and re-encoded JSON. `Limenia-Signature` is `t=<unix>,v1=<hex>`: `t` must appear exactly once, at least one `v1` must match `hex(HMAC-SHA256(secret, t + "." + body))`, and `t` may be at most 300 seconds off in either direction. The comparison uses `hmac.Equal` (constant time), and every configured secret is tried (rotation).
- Events are deduplicated by `id` and only marked as processed after they were handled. A failure answers `503`, so Limenia retries (for about 20 hours). Duplicates and unknown event types are acknowledged with `204`.
- `decision.created` calls one method of `Actions` per action. A decision with `reviewId` (pre-moderation) only concerns the submitted content and never changes the account, also not for `restore`. For other `restore` decisions, `restoreScope` says whether the account or the content is restored.
- Events can arrive out of order. Keep the time of the last change you applied per user and per content (`Decision.DecidedAt`, `CreatedAt` of `subject.status_changed`) and ignore older events.
- Handle events quickly: Limenia waits at most 10 seconds for the answer. For slow work, store the event, answer `204`, and process it in the background.
- The in-memory stores (processed events, request hashes) are for the example only. Use your database or cache in production.
