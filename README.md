# Limenia examples

Example backends for [Limenia](https://app.limenia.eu), the moderation service for apps. Each example shows how your app backend sends reports to Limenia, receives its decisions as signed webhooks, and forwards device checks. They use plain HTTP and the platform's own crypto, no Limenia SDK, so you can read exactly what goes over the wire.

## How it fits together

Limenia keeps no copy of your app's users or data beyond what you send with a report. Your app never talks to Limenia directly: the API key would be readable in every installed copy of the app.

```
App ── your login ──▶ Your backend ── API key ──▶ Limenia   (POST /v1/reports, /v1/devices/check ...)
                      Your backend ◀── webhook ── Limenia   (decision.created, signed with your webhook secret)
App ◀── your push / in-app message ──┘
```

1. A user reports content in your app. The app calls **your** backend with its normal login.
2. Your backend takes the user from that login, builds the report and sends it to Limenia's ingest API `/v1` with the API key of your app.
3. A moderator decides in the Limenia dashboard.
4. Limenia sends the decision to your webhook URL. Your backend verifies the signature, applies the action (remove content, suspend a user, ...) and tells the people concerned.

## Configuration

Every example reads the same variables:

| Variable | Meaning |
|---|---|
| `LIMENIA_BASE_URL` | Address of Limenia without `/v1`, default `https://app.limenia.eu` |
| `LIMENIA_API_KEY` | API key of your app (Limenia dashboard, app settings). Server-side only. |
| `LIMENIA_WEBHOOK_SECRET` | Secret of your webhook, shown once when you create it |
| `LIMENIA_WEBHOOK_SECRET_PREVIOUS` | Optional: the previous secret, only while you rotate it |

`GET /v1/ping` with the key checks address and key in one call:

```sh
curl -sS "$LIMENIA_BASE_URL/v1/ping" -H "Authorization: Bearer $LIMENIA_API_KEY"
```

## The examples

| Example | Routes of your backend | What it shows in particular |
|---|---|---|
| [`node-express/`](node-express) | `POST /reports`, `GET /me/moderation-status`, `POST /appeals`, `GET /appeals/{id}`, `POST /reviews`, `GET /reviews/{id}`, `POST /devices/request-hash`, `POST /devices/check`, `POST /limenia/webhook` | The full reference: also complaints and review before publishing, ordering of events by `decidedAt` |
| [`python-fastapi/`](python-fastapi) | `POST /reports`, `GET /me/moderation-status`, `POST /devices/request-hash`, `POST /devices/check`, `POST /limenia/webhook` | FastAPI with `httpx` |
| [`go/`](go) | `POST /reports`, `GET /me/moderation-status`, `POST /devices/request-hash`, `POST /devices/check`, `POST /limenia/webhook` | Standard library only, no dependencies |
| [`php-laravel/`](php-laravel) | `POST /api/reports`, `GET /api/me/moderation-status`, `POST /api/devices/request-hash`, `POST /api/devices/check`, `POST /api/limenia/webhook` | Files that drop into a Laravel 11 app |
| [`firebase-cloud-functions/`](firebase-cloud-functions) | Callable `submitReport`, `getMyModerationStatus`, `requestDeviceHash`, `checkDevice`; HTTP `limeniaWebhook` | Cloud Functions 2nd gen: Firebase Auth as the login, errors as `HttpsError`, `req.rawBody`, dedupe in Firestore, optionally disabling the Firebase user on a ban |
| [`aws-lambda/`](aws-lambda) | `POST /reports`, `GET /me/moderation-status`, `POST /devices/request-hash`, `POST /devices/check`, `POST /limenia/webhook` | One Node.js 20 handler for a Function URL or an API Gateway HTTP API, base64 bodies, JWT authorizer claims, DynamoDB dedupe |
| [`supabase-edge-functions/`](supabase-edge-functions) | `limenia-reports`, `limenia-moderation-status`, `limenia-devices/request-hash`, `limenia-devices/check`, `limenia-webhook` | Deno with Web Crypto, Supabase Auth as the login, dedupe in a table, optionally banning the Supabase user with `ban_duration` |

All seven:

- forward a report (`POST /v1/reports`) with the reporter taken from the login, pass the app's `Idempotency-Key` through (or generate `report-<random>`) and echo it back (Firebase: in the error details), and return Limenia's status, problem body and `Retry-After` to the app
- retry network errors, `429` and `5xx` up to five times with 1, 2, 4 and 8 s pause and at least `Retry-After`; a `Retry-After` above 30 s goes back to the app (the Lambda example uses shorter limits because of API Gateway's 30 s cap)
- return the moderation status of the signed-in user only (`GET /v1/subjects/{id}/status`)
- run the device check (`POST /v1/devices/check`) with a request hash issued by the backend, and fail open
- verify webhooks, dedupe them by event ID and handle every event type

The serverless examples (Firebase, Lambda, Supabase) keep no memory between calls. Instead of storing the device request hash for 10 minutes, they hand the app a signed ticket with the nonce and an expiry, and recompute the hash from it.

Each example has its own README with setup, run, curl examples, deployment hints and tests.

## Security rules

These hold for every integration, whatever the language:

1. **The API key never goes into the app.** Not in the binary, not in a config file, not in a remote config. The app talks to your backend only.
2. **The backend sets the people.** `reporter.externalUserId` of a report, `appellant.externalUserId` of a complaint and the author of a review come from your own login, never from the request body. Use a stable internal user ID, not an e-mail address.
3. **Verify every webhook on the raw body.** Check `Limenia-Signature` on the bytes exactly as received, before parsing. Parsing and re-serializing JSON changes the bytes and breaks the signature.
4. **Dedupe by event ID.** Limenia delivers at least once: the same event can arrive again with the same `id` and a new signature. Remember processed IDs, mark an event processed only after handling it, and make actions idempotent (set a state, do not toggle it).
5. **Use idempotency keys.** `POST /v1/reports`, `/v1/appeals` and `/v1/reviews` require an `Idempotency-Key`. Create one key per report in the app, keep it, and send the same key with the same body on every retry. The same key with a different body is rejected (`409 idempotency_key_reused`).
6. **Fail open on device checks.** A device check that could not run (network error, `429`, `5xx`, `status: "unevaluated"`, `deviceFlag: "unknown"`) is never a reason to reject a user. A marked device is a hint, never proof.
7. **Log IDs, not content.** Log event, decision, report and user IDs; never report texts, statements, names or e-mail addresses.

## Webhooks

Limenia sends `POST` requests with these headers:

| Header | Content |
|---|---|
| `Limenia-Event-Id` | `evt_` plus a ULID, equal to `id` in the body |
| `Limenia-Event-Type` | `decision.created`, `subject.status_changed`, `appeal.resolved`, `reports.resolved`, `review.decided` or `test.ping` |
| `Limenia-Signature` | `t=<unix seconds>,v1=<hex>` |

What the examples do per event:

| Event | Action |
|---|---|
| `decision.created` | Apply `decision.action`: `remove_content`, `restrict_content`, `reject_submission` (content); `warn_user`, `suspend_user` (until `suspendUntil`), `ban_user` (account); `restore` (lift the restriction named by `restoreScope`: `content` or `account`); `dismiss` changes nothing. Decisions with `reviewId` only ever touch content, never the account. Show `statementOfReasons.text` to the affected user. |
| `subject.status_changed` | Set the account status (`active`, `warned`, `suspended`, `banned`), e.g. when a suspension ends |
| `appeal.resolved` | Show `statementText` to the person who complained; with `outcome: "changed"` the new decision follows as its own `decision.created` |
| `reports.resolved` | Tell the reporters the outcome (`items[].externalReportId`) and that they can complain until `appealDeadline` |
| `review.decided` | Publish (`approved`), publish restricted (`restricted`) or keep unpublished (`rejected`) |
| `test.ping` and unknown types | Acknowledge with `204` |

Answer within 10 seconds with `2xx`. Any other answer, a timeout or a redirect counts as a failure, and Limenia retries for about 20 hours. Events can arrive out of order; the node-express example shows how to skip a decision that is older than the last one applied.

### Signature

```
signature = hex(HMAC-SHA256(secret, t + "." + rawBody))
```

1. Split the header at commas. `t` must appear exactly once, `v1` at least once (there can be several).
2. Reject the request if `t` is more than 300 seconds away from your clock, in either direction.
3. Compute the HMAC over the raw body and compare it with each `v1` value in constant time. Accept if one matches, for the current or (while rotating) the previous secret.

**Test vector.** Every example tests against it:

| | |
|---|---|
| Secret | `whsec_test` |
| `t` | `1800000000` |
| Body | `{"id":"evt_1"}` |
| `v1` | `45705be2a45ab5acdd1395cc695e9e7073125385ec24194921c401dff44176f8` |

```sh
printf '%s' '1800000000.{"id":"evt_1"}' | openssl dgst -sha256 -hmac whsec_test
```

## Device check

For the device connector, the app gets a single-use token from the Flutter plugin [`limenia_device`](https://github.com/DL3KB/limenia-flutter) (Play Integrity on Android, DeviceCheck on iOS) and sends it to your backend, which forwards it to `POST /v1/devices/check`:

1. The backend picks a random nonce and computes `requestHash = base64url(SHA-256("limenia:" + userId + ":" + nonce))` without padding for the signed-in user.
2. The app calls `LimeniaDevice.requestToken(requestHash: ...)` and sends `platform` and `token` to the backend.
3. The backend sends `externalUserId` (from the login), `platform`, `token`, `requestHash` (Android only), `environment` (iOS only, `development` for debug builds) and `event` (`registration`, `login`, `report` or `other`) to Limenia, once, without retry.

Check at registration and at every login, also the login of a banned account before you reject it: only then can Limenia mark the device.

## License

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). The license grants no rights to use the name "Limenia".
