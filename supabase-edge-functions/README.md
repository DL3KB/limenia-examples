# Supabase Edge Functions

Four Edge Functions (Deno) between your Supabase app and Limenia. The login is Supabase Auth: the app calls the functions with the user's access token, and the Supabase user ID is the `externalUserId` at Limenia. Plain `fetch` and Web Crypto, no Limenia SDK.

| Function and route | Calls Limenia | What it shows |
|---|---|---|
| `POST /functions/v1/limenia-reports` | `POST /v1/reports` | Reporter from the Supabase JWT, `Idempotency-Key` passed through or generated and echoed, retries |
| `GET /functions/v1/limenia-moderation-status` | `GET /v1/subjects/{id}/status` | Status of the signed-in user only |
| `POST /functions/v1/limenia-devices/request-hash`, `.../check` | `POST /v1/devices/check` | Request hash for `limenia_device`, signed ticket instead of server state, fail-open |
| `POST /functions/v1/limenia-webhook` | (called by Limenia) | Signature with Web Crypto on the raw body, dedupe in a table, all event types, optional ban of the Supabase user |

```
supabase/
  functions/
    _shared/           limenia.ts (client), signature.ts, events.ts, actions.ts (placeholders),
                       handlers.ts, http.ts, supabase.ts (login, admin client), device-ticket.ts, config.ts
    limenia-reports/index.ts
    limenia-moderation-status/index.ts
    limenia-devices/index.ts
    limenia-webhook/index.ts
    tests/             deno test
  migrations/          table limenia_webhook_events
```

## Setup

The Supabase CLI and, for the tests, Deno 2. Copy `supabase/functions` and `supabase/migrations` into your Supabase project (the folder with `supabase/config.toml`), or run `supabase init` here first.

```sh
cp .env.example .env              # fill in the Limenia values
supabase link --project-ref <your-project-ref>
supabase db push                  # creates limenia_webhook_events
supabase secrets set --env-file .env
```

| Secret | Meaning |
|---|---|
| `LIMENIA_BASE_URL` | `https://app.limenia.eu` (default), without `/v1` |
| `LIMENIA_API_KEY` | API key of your app, never in the app |
| `LIMENIA_WEBHOOK_SECRET` | Secret of your webhook |
| `LIMENIA_WEBHOOK_SECRET_PREVIOUS` | Optional, the old secret while you rotate |
| `DEVICE_CHECK_SECRET` | Signs device check tickets; any random string |
| `LIMENIA_BAN_SUPABASE_USERS` | `true`: ban the Supabase user on ban and suspension, lift it on restore |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set by Supabase in every Edge Function. The service role key bypasses Row Level Security; it stays in the functions and never goes to the app.

## Test

```sh
deno task test      # signature test vector, wrong secret, old timestamp, tampered body, handlers
deno task check     # type check of all functions
deno task lint      # deno lint and deno fmt --check
```

The functions import `jsr:` packages inline, like the Supabase docs do, so they deploy without an import map; `deno.json` here only configures the tasks, formatting and lint.

## Run and deploy

```sh
supabase functions serve --env-file .env --no-verify-jwt   # local; the webhook needs no JWT
supabase functions deploy limenia-reports
supabase functions deploy limenia-moderation-status
supabase functions deploy limenia-devices
supabase functions deploy limenia-webhook --no-verify-jwt
```

Deploy the webhook with `--no-verify-jwt` (or `[functions.limenia-webhook] verify_jwt = false` in `config.toml`): Limenia sends no Supabase JWT, the signature is the authentication. Enter `https://<project-ref>.supabase.co/functions/v1/limenia-webhook` as the webhook URL in the Limenia dashboard and use its test button.

## Calling from the app

```ts
// supabase-js sends the access token of the signed-in user.
const { data, error } = await supabase.functions.invoke("limenia-reports", {
  body: {
    reasonCategory: "spam",
    subject: { externalUserId: authorId },
    content: { externalContentId: "comment_5521", contentType: "comment", text: commentText },
  },
  headers: { "Idempotency-Key": reportKey }, // one key per report, the same on every retry
});
```

With curl:

```sh
FN=https://<project-ref>.supabase.co/functions/v1
curl -i -X POST "$FN/limenia-reports" -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: report-7f3c9a' \
  -d '{"reasonCategory":"spam","subject":{"externalUserId":"<author-id>"},"content":{"externalContentId":"comment_5521","contentType":"comment"}}'
curl -i "$FN/limenia-moderation-status" -H "Authorization: Bearer $USER_ACCESS_TOKEN"

BODY='{"id":"evt_local_1","type":"test.ping","createdAt":"2026-10-01T10:00:00Z","app":{"id":"a","slug":"demo"}}'
T=$(date +%s)
SIG=$(printf '%s' "$T.$BODY" | openssl dgst -sha256 -hmac "$LIMENIA_WEBHOOK_SECRET" -hex | sed 's/.* //')
curl -i -X POST "$FN/limenia-webhook" -H 'Content-Type: application/json' -H "Limenia-Signature: t=$T,v1=$SIG" --data "$BODY"
```

The anon key alone is no user: the functions ask Supabase Auth for the user behind the token and answer `401` without one. If your app uses another login, replace `userFromRequest` in `_shared/supabase.ts`.

## How it behaves

**Reports.** The function sets `source: "user"` and `reporter.externalUserId` from the JWT and passes on only `reasonCategory`, `reasonText`, `goodFaith`, `subject`, `content` and `externalReportId`. The `Idempotency-Key` of the app is passed through, or `report-<uuid>` is generated, and comes back in the response header. Limenia's status, problem body and `Retry-After` reach the app unchanged. No answer at all becomes `502 limenia_unreachable`. A `401` from Limenia means the API key is wrong, not that the user is signed out.

**Retries.** Network errors, timeouts (30 s), `429` and `5xx` are retried up to five attempts with 1, 2, 4 and 8 s pause, at least `Retry-After`; a `Retry-After` above 30 s goes back to the app.

**Device check.** `limenia-devices/request-hash` returns `{ requestHash, ticket }`. The ticket carries a random nonce, an expiry of 10 minutes and an HMAC over user, nonce and expiry, so the function needs no storage. The app requests a token with `requestHash` (plugin `limenia_device`) and posts `platform`, `token`, `ticket` (and `environment: "development"` for iOS debug builds) to `limenia-devices/check`. The token is sent once; network errors, `429` and `5xx` answer `{"status":"unevaluated","deviceFlag":"unknown"}`, never a reason to reject.

**Webhook.** `verifySignature` uses `crypto.subtle` (HMAC-SHA256) over `await req.arrayBuffer()`, accepts any `v1` and the current or previous secret, rejects timestamps more than 300 s off, and compares in constant time. Then:

- IDs already in `limenia_webhook_events` are acknowledged with `204`; an event is marked processed only after handling
- `decision.created` is applied per `action`; decisions with `reviewId` only touch content, `restore` follows `restoreScope`
- `subject.status_changed`, `appeal.resolved`, `reports.resolved` and `review.decided` call the placeholders; `test.ping` and unknown types get `204`
- the answer comes within 8 s; a failure answers `503`, and Limenia retries

**Banning the Supabase user.** With `LIMENIA_BAN_SUPABASE_USERS=true`:

| Event | Call |
|---|---|
| `ban_user` | `supabase.auth.admin.updateUserById(id, { ban_duration: "876000h" })` |
| `suspend_user` | `ban_duration` = hours until `suspendUntil`, rounded up |
| `restore` with `restoreScope: "account"`, `subject.status_changed` to `active` or `warned` | `ban_duration: "none"` |

A banned user cannot sign in or refresh a session; an access token already issued stays valid until it expires, so check the ban in your own policies too if that matters. The external user ID must be the Supabase user ID. For ordering by `decidedAt`, see the node-express example.
