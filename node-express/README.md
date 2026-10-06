# Node.js and Express

The reference example: an Express backend between your app and Limenia. It uses plain `fetch` and Node's `crypto`; the only dependency is Express.

| Route of this backend | Calls Limenia | What it shows |
|---|---|---|
| `POST /reports` | `POST /v1/reports` | Reporter from the login, `Idempotency-Key` passed through or generated and echoed, retries with backoff and `Retry-After` |
| `GET /me/moderation-status` | `GET /v1/subjects/{id}/status` | Status of the signed-in user only |
| `POST /appeals`, `GET /appeals/:id` | `POST /v1/appeals`, `GET /v1/appeals/{id}` | Complaints; the status only goes to the person who complained |
| `POST /reviews`, `GET /reviews/:id` | `POST /v1/reviews`, `GET /v1/reviews/{id}` | Review before publishing; the author is the signed-in user |
| `POST /devices/request-hash`, `POST /devices/check` | `POST /v1/devices/check` | Request hash for the token of `limenia_device`, single use, fail-open |
| `POST /limenia/webhook` | (called by Limenia) | Signature on the raw body, dedupe by event ID, all event types |

Files:

- `src/limenia.js`: the HTTP client with retries
- `src/signature.js`: verification of `Limenia-Signature`
- `src/events.js`: what happens per event, with dedupe and ordering
- `src/actions.js`: **placeholders** for your app (remove content, ban a user, notify)
- `src/auth.js`: **auth stub, replace with your login**
- `src/device.js`: request hash for the device check
- `src/app.js`: the routes

## Setup

Node.js 20.6 or newer.

```sh
cd node-express
npm install
cp .env.example .env   # fill in LIMENIA_API_KEY and LIMENIA_WEBHOOK_SECRET
npm start
npm test
```

| Variable | Meaning |
|---|---|
| `LIMENIA_BASE_URL` | `https://app.limenia.eu` (default), without `/v1` |
| `LIMENIA_API_KEY` | API key of your app, server-side only |
| `LIMENIA_WEBHOOK_SECRET` | Secret of your webhook |
| `LIMENIA_WEBHOOK_SECRET_PREVIOUS` | Optional, the old secret while you rotate |
| `PORT` | Default `3000` |

## Try it

The login is a stub: it takes the user from the header `X-User-Id`. **Replace `requireUser` in `src/auth.js` with your own login.** The stub refuses every request when `NODE_ENV=production`.

```sh
# Report a comment (the reporter is u_829, taken from the "login")
curl -i -X POST localhost:3000/reports \
  -H 'Content-Type: application/json' -H 'X-User-Id: u_829' \
  -H 'Idempotency-Key: report-7f3c9a' \
  -d '{"reasonCategory":"harassment_hate","subject":{"externalUserId":"u_112"},
       "content":{"externalContentId":"comment_5521","contentType":"comment","text":"..."}}'

# Own moderation status
curl -i localhost:3000/me/moderation-status -H 'X-User-Id: u_112'

# Complaint against a decision
curl -i -X POST localhost:3000/appeals \
  -H 'Content-Type: application/json' -H 'X-User-Id: u_112' -H 'Idempotency-Key: a-17' \
  -d '{"decisionId":"01K6G5H1TR8W4QZ3M0XCB7NDEC","appellantType":"subject","text":"It was a quote."}'

# Device check in test mode (turn on the test mode of the device connector first)
curl -i -X POST localhost:3000/devices/check \
  -H 'Content-Type: application/json' -H 'X-User-Id: u_112' \
  -d '{"platform":"test","token":"test:emulator-1","event":"login"}'

# A signed test webhook
BODY='{"id":"evt_local_1","type":"test.ping","createdAt":"2026-10-01T10:00:00Z","app":{"id":"a","slug":"demo"}}'
T=$(date +%s)
SIG=$(printf '%s' "$T.$BODY" | openssl dgst -sha256 -hmac "$LIMENIA_WEBHOOK_SECRET" -hex | sed 's/.* //')
curl -i -X POST localhost:3000/limenia/webhook \
  -H 'Content-Type: application/json' -H "Limenia-Signature: t=$T,v1=$SIG" --data "$BODY"
```

For a real delivery, expose the server with a tunnel (any HTTPS tunnel works), enter `https://<host>/limenia/webhook` as the webhook URL in the Limenia dashboard and use its test button.

## How it behaves

**Reports, complaints, review requests.** The backend builds the request from an allowlist of fields and sets the person from the login: `reporter.externalUserId`, `appellant.externalUserId`, `subject.externalUserId` of a review. `source` is always `user`, and only `reasonCategory`, `reasonText`, `subject`, `content` and `externalReportId` are passed on. The app should create one `Idempotency-Key` per report and send it again on every retry; without one the backend generates `report-<uuid>`, which only covers its own retries. The key used comes back in the response header `Idempotency-Key`.

**Errors.** Limenia's status, its `application/problem+json` body and `Retry-After` go to the app unchanged, so the app can show field errors (`errors`), `reporterWarning` and `reporter_suspended` with `suspendedUntil`. No answer at all becomes `502 limenia_unreachable`. A `401` from Limenia means the backend's API key is wrong; the app must not sign the user out because of it.

**Retries.** Network errors, timeouts (30 s), `429` and `5xx` are retried up to five attempts with 1, 2, 4 and 8 s pause, at least `Retry-After`. A `Retry-After` above 30 s goes back to the app instead of blocking the request. For reports you must not lose, put them in your own queue and resend them within 24 hours with the same key and body.

**Device check.** `POST /devices/request-hash` returns `requestHash = base64url(SHA-256("limenia:" + userId + ":" + nonce))` and keeps it for this user for 10 minutes. The app requests a token with it from `limenia_device` and sends `platform`, `token` (and `event`, and `environment: "development"` for iOS debug builds) to `POST /devices/check`. For Android the backend uses the hash it kept, once. The token is sent exactly once (no retry, it is single-use); a network error, `429` or `5xx` answers `{"status":"unevaluated","deviceFlag":"unknown"}`, never a reason to reject. Decide in that route what follows; the example returns Limenia's answer.

**Webhooks.** The route reads the raw body (`express.raw`, registered before `express.json`), checks `Limenia-Signature` (several `v1` values, 300 s tolerance, constant-time comparison, current and previous secret), then:

- skips event IDs it has seen and acknowledges them with `204`
- applies `decision.created` per `action`; decisions with `reviewId` never change the account, `restore` follows `restoreScope`
- skips decisions and status changes older than the last one applied to the same user or content (events can arrive out of order)
- answers `204` within 8 s, `503` on failure (Limenia retries), `401` on a bad signature and `204` for unknown event types

`MemoryEventStore` and the device hash store live in memory. Replace them with your database or Redis as soon as you run more than one instance.

## Deploy

Any Node host works (a container platform, a VM, a PaaS). Set the environment variables as secrets of the platform, run `npm ci --omit=dev && node src/server.js`, serve it over HTTPS, and make sure the webhook URL is reachable without redirects: Limenia does not follow them.
