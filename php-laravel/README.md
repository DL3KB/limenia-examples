# Limenia with PHP and Laravel

Files that drop into a Laravel 11 app (PHP 8.2 or later) to use Limenia. They talk to the Limenia API with Laravel's HTTP client, no SDK and no extra packages.

| Endpoint (under `/api`) | What it does | Limenia API |
|---|---|---|
| `POST /api/reports` | A signed-in user reports content or another user | `POST /v1/reports` |
| `GET /api/me/moderation-status` | The signed-in user's own moderation status | `GET /v1/subjects/{id}/status` |
| `POST /api/devices/request-hash` | Step 1 of a device check: a request hash for the app | none |
| `POST /api/devices/check` | Step 2: forwards the device token from the app | `POST /v1/devices/check` |
| `POST /api/limenia/webhook` | Receives signed webhook events from Limenia | none (Limenia calls you) |

The app never talks to Limenia directly and never sees the API key.

## Files

| File | Purpose |
|---|---|
| `config/limenia.php` | Configuration from the environment |
| `routes/limenia.php` | The routes above |
| `app/Http/Controllers/LimeniaController.php` | Reports, status and device check, with the login stub |
| `app/Http/Controllers/LimeniaWebhookController.php` | Webhook receiver: signature, deduplication, dispatch |
| `app/Limenia/LimeniaClient.php` | Small service class: HTTP requests with retries, device request hash |
| `app/Limenia/WebhookSignature.php` | Verification of `Limenia-Signature`, plain PHP |
| `app/Limenia/InvalidSignature.php` | Exception of the verifier |
| `app/Limenia/LimeniaEventHandler.php` | What to do with each event (placeholders marked `TODO`) |
| `tests/webhook_signature_test.php` | Framework-free test of the verifier |

## Setup

1. Copy `app/`, `config/` and `routes/limenia.php` into your Laravel app.
2. If your app has no `routes/api.php` yet, run `php artisan install:api`. Then add this line to `routes/api.php`:

   ```php
   require __DIR__.'/limenia.php';
   ```

   The `api` group has no CSRF check, which the webhook needs.
3. Add the variables from `.env.example` to your `.env`:

   | Variable | Required | Meaning |
   |---|---|---|
   | `LIMENIA_BASE_URL` | no | Address of Limenia without `/v1`, default `https://app.limenia.eu` |
   | `LIMENIA_API_KEY` | yes | API key of your app, from the Limenia dashboard |
   | `LIMENIA_WEBHOOK_SECRET` | yes | Webhook secret of your app |
   | `LIMENIA_WEBHOOK_SECRET_PREVIOUS` | no | The previous secret, only while you rotate it |

4. **Replace the login stub.** `currentUser()` in `LimeniaController` trusts the header `X-User-Id` so you can try the example. Put the app routes behind your auth middleware (e.g. `auth:sanctum`) and return `$request->user()->getAuthIdentifier()` instead. Do not put the webhook route behind auth: its signature is the authentication.

## Run

```sh
php artisan serve
```

Your webhook URL must be public and use `https`, for example through a tunnel during development. Enter `https://<your host>/api/limenia/webhook` in the dashboard.

## Test

The verifier has a test without Laravel or PHPUnit:

```sh
php tests/webhook_signature_test.php
```

It checks the test vector (secret `whsec_test`, `t=1800000000`, body `{"id":"evt_1"}`), a wrong secret, rotation, old and future timestamps, a tampered body, two `v1` values and malformed headers.

## Try it

Report a comment. Send the same `Idempotency-Key` again when you retry the same report:

```sh
curl -i -X POST localhost:8000/api/reports \
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
curl -i localhost:8000/api/me/moderation-status -H 'X-User-Id: u_112'
```

A device check. In a Flutter app the token comes from the plugin [`limenia_device`](https://github.com/DL3KB/limenia-flutter) (`LimeniaDevice.requestToken(requestHash: ...)`). With the test mode of the device connector you can use test tokens:

```sh
curl -s -X POST localhost:8000/api/devices/request-hash -H 'X-User-Id: u_112'
curl -i -X POST localhost:8000/api/devices/check \
  -H 'X-User-Id: u_112' -H 'Content-Type: application/json' \
  -d '{"platform": "test", "token": "test:device-1", "event": "login"}'
```

A signed test webhook (secret `whsec_test` here; set `LIMENIA_WEBHOOK_SECRET=whsec_test` for this):

```sh
BODY='{"id":"evt_local_1","type":"test.ping","createdAt":"2026-10-01T10:00:00Z","app":{"id":"app_1","slug":"demo"}}'
T=$(date +%s)
SIG=$(printf '%s' "$T.$BODY" | openssl dgst -sha256 -hmac whsec_test -hex | sed 's/^.* //')
curl -i -X POST localhost:8000/api/limenia/webhook \
  -H "Limenia-Signature: t=$T,v1=$SIG" -H 'Content-Type: application/json' --data "$BODY"
```

## How it works

### Reports

- `source` is always `user`, and `reporter.externalUserId` comes from the login, never from the request body. The other fields (`reasonCategory`, `reasonText`, `goodFaith`, `subject`, `content`, `externalReportId`) are passed on. In a real app, load `subject` and `content` from your own database by ID instead of trusting what the app sends.
- `Idempotency-Key` is required by Limenia. The app should create one key per report, keep it, and resend it with every retry of that report. Without a key, the controller generates one; it then only protects its own retries. The key is returned in the `Idempotency-Key` response header.
- Network errors, `429` and `5xx` are retried up to 5 times with backoff of 1, 2, 4 and 8 seconds, waiting at least `Retry-After`. A `Retry-After` above 30 seconds is passed on to the app instead. Other `4xx` are never retried. Waiting blocks a PHP worker; for heavy traffic, send reports from a queued job instead.
- Limenia's status, body (`application/problem+json` for errors) and `Retry-After` are passed on unchanged. If the report still fails, queue it and send it again within 24 hours with the same key.

### Status

`GET /api/me/moderation-status` only ever asks for the signed-in user. The ID is encoded with `rawurlencode`, so IDs with `/` work. Use it as a fallback, for example at login, not on every request.

### Device check

1. The app asks `POST /api/devices/request-hash`. The controller picks a random nonce and returns `base64url(SHA-256("limenia:" + userId + ":" + nonce))` without padding. It keeps the hash in the cache for 10 minutes.
2. The app gets a token with that hash and sends `{platform, token, event, environment}` to `POST /api/devices/check`. `event` is `registration`, `login`, `report` or `other`; `environment` is only for iOS debug builds (`development`).
3. The controller forwards token, user and (Android only) the hash to Limenia, once: a token is single-use, so it is never retried. On a network error, `429` or `5xx` it answers `{"status": "unevaluated", "deviceFlag": "unknown"}` (fail open).

Check at registration and at every login, also for a banned or suspended account before you reject its login. Suggested use of the result:

- `subject.status` is `banned` or `suspended`: reject the login as you already do.
- `deviceFlag: banned` at a registration: do not reject automatically; restrict the new account until a moderator has decided, or let a Limenia rule open a case.
- `unevaluated` and `unknown` are never a reason to reject anyone.

### Webhooks

- The signature is checked on the raw body (`$request->getContent()`), never on `$request->all()` or re-encoded JSON. `Limenia-Signature` is `t=<unix>,v1=<hex>`: `t` must appear exactly once, at least one `v1` must match `hex(HMAC-SHA256(secret, t + "." + body))`, and `t` may be at most 300 seconds off in either direction. The comparison uses `hash_equals` (constant time), and every configured secret is tried (rotation).
- Events are deduplicated by `id` (in the cache here; a table with a unique key is safer) and only marked as processed after they were handled. A failure answers `503`, so Limenia retries (for about 20 hours). Duplicates and unknown event types are acknowledged with `204`.
- `decision.created` calls one placeholder per action. A decision with `reviewId` (pre-moderation) only concerns the submitted content and never changes the account, also not for `restore`. For other `restore` decisions, `restoreScope` says whether the account or the content is restored.
- Events can arrive out of order. Keep the time of the last change you applied per user and per content (`decision.decidedAt`, `createdAt` of `subject.status_changed`) and ignore older events.
- Handle events quickly: Limenia waits at most 10 seconds for the answer. For slow work, store the event, answer `204`, and process it in a queued job.
