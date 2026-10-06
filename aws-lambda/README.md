# AWS Lambda

One Lambda function (Node.js 20, no dependencies) behind a Lambda Function URL or an API Gateway HTTP API, payload format 2.0. Plain `fetch` and Node's `crypto`, no Limenia SDK.

| Route | Calls Limenia | What it shows |
|---|---|---|
| `POST /reports` | `POST /v1/reports` | Reporter from the login, `Idempotency-Key` passed through or generated and echoed, retries |
| `GET /me/moderation-status` | `GET /v1/subjects/{id}/status` | Status of the signed-in user only |
| `POST /devices/request-hash`, `POST /devices/check` | `POST /v1/devices/check` | Request hash for `limenia_device`, signed ticket instead of server state, fail-open |
| `POST /limenia/webhook` | (called by Limenia) | Raw body incl. base64 decoding, signature, dedupe (memory or DynamoDB), all event types |

Files in `src/`: `handler.js` (routing, **auth stub**), `limenia.js` (HTTP client with retries), `signature.js`, `events.js`, `actions.js` (**placeholders** for your app), `event-store.js`, `device-ticket.js`.

## Setup

```sh
cd aws-lambda
npm test            # no npm install needed, there are no dependencies
npm run package     # function.zip
```

Environment variables of the function (see `.env.example`):

| Variable | Meaning |
|---|---|
| `LIMENIA_BASE_URL` | `https://app.limenia.eu` (default), without `/v1` |
| `LIMENIA_API_KEY` | API key of your app, never in the app |
| `LIMENIA_WEBHOOK_SECRET` | Secret of your webhook |
| `LIMENIA_WEBHOOK_SECRET_PREVIOUS` | Optional, the old secret while you rotate |
| `DEVICE_CHECK_SECRET` | Signs device check tickets; any random string |
| `LIMENIA_EVENTS_TABLE` | Optional DynamoDB table for processed event IDs |

Plain environment variables are visible to everyone who can read the function's configuration. For production, load the key and the secrets from AWS Secrets Manager or SSM Parameter Store (e.g. with the Parameters and Secrets Lambda extension) and keep them out of logs.

## Deploy

```sh
aws iam create-role --role-name limenia-example-lambda \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name limenia-example-lambda \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

aws lambda create-function --function-name limenia-example \
  --runtime nodejs20.x --handler src/handler.handler --timeout 30 --memory-size 256 \
  --role "arn:aws:iam::<account-id>:role/limenia-example-lambda" \
  --zip-file fileb://function.zip \
  --environment "Variables={LIMENIA_API_KEY=...,LIMENIA_WEBHOOK_SECRET=...,DEVICE_CHECK_SECRET=...}"
```

Then pick one of two ways in front of it:

- **API Gateway HTTP API (recommended).** Routes `POST /reports`, `GET /me/moderation-status`, `POST /devices/request-hash` and `POST /devices/check` with a JWT authorizer (e.g. Amazon Cognito); the handler takes the user from `requestContext.authorizer.jwt.claims.sub`. Route `POST /limenia/webhook` without an authorizer: the signature is its authentication. Use the `$default` stage, or the stage name becomes part of the path.
- **Function URL** with auth type `NONE`. Simple, but every route is public, so replace the auth stub in `handler.js` with your own token check first.

Enter `https://<your-api>/limenia/webhook` as the webhook URL in the Limenia dashboard and use its test button.

For dedupe across instances create a table and set `LIMENIA_EVENTS_TABLE`:

```sh
aws dynamodb create-table --table-name limenia-webhook-events \
  --attribute-definitions AttributeName=id,AttributeType=S --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
aws dynamodb update-time-to-live --table-name limenia-webhook-events \
  --time-to-live-specification "Enabled=true,AttributeName=expireAt"
```

and allow the role `dynamodb:GetItem` and `dynamodb:PutItem` on it.

## Try it

The login is a stub: without a JWT authorizer it takes the user from the header `X-User-Id` (refused when `NODE_ENV=production`). **Replace `currentUserId` in `src/handler.js` with your own login.**

```sh
URL=https://<your-api>
curl -i -X POST "$URL/reports" -H 'content-type: application/json' -H 'X-User-Id: u_829' \
  -H 'Idempotency-Key: report-7f3c9a' \
  -d '{"reasonCategory":"spam","subject":{"externalUserId":"u_112"},"content":{"externalContentId":"comment_5521","contentType":"comment"}}'
curl -i "$URL/me/moderation-status" -H 'X-User-Id: u_112'
```

A signed test webhook:

```sh
BODY='{"id":"evt_local_1","type":"test.ping","createdAt":"2026-10-01T10:00:00Z","app":{"id":"a","slug":"demo"}}'
T=$(date +%s)
SIG=$(printf '%s' "$T.$BODY" | openssl dgst -sha256 -hmac "$LIMENIA_WEBHOOK_SECRET" -hex | sed 's/.* //')
curl -i -X POST "$URL/limenia/webhook" -H 'content-type: application/json' -H "limenia-signature: t=$T,v1=$SIG" --data "$BODY"
```

## How it behaves

**Raw body.** Lambda hands the body over as a string, base64-encoded when `isBase64Encoded` is true. `rawBody()` turns it back into the exact bytes Limenia signed; the signature is checked on those, before any JSON parsing.

**Webhook.** 300 s tolerance, any `v1` value, constant-time comparison, current and previous secret. Seen event IDs are acknowledged with `204`; an event is marked processed only after handling. `decision.created` is applied per `action`, never changing the account for decisions with `reviewId`; `restore` follows `restoreScope`. `test.ping` and unknown types get `204`, a failure `503` (Limenia retries), all within 8 s (Limenia waits 10 s). For ordering by `decidedAt`, see the node-express example.

**Reports.** `source` is always `user`, the reporter comes from the login, and only `reasonCategory`, `reasonText`, `subject`, `content` and `externalReportId` are passed on. The app's `Idempotency-Key` is passed through, or `report-<uuid>` is generated; the key used comes back in the response header. Limenia's status, problem body and `Retry-After` reach the app unchanged; no answer at all becomes `502 limenia_unreachable`. A `401` from Limenia means the API key is wrong, not that the user is signed out.

**Retries.** The other examples try up to five times (1, 2, 4, 8 s pause) and wait for a `Retry-After` of up to 30 s. An API Gateway HTTP API ends requests after 30 s, so this one uses a 12 s timeout per attempt, two attempts, and waits for `Retry-After` up to 5 s; a longer one goes back to the app with status `429` and the header. Behind a Function URL you can raise the limits in `createHandler` (and the function timeout).

**Device check.** `POST /devices/request-hash` returns `{ requestHash, ticket }`. The ticket carries a random nonce, an expiry of 10 minutes and an HMAC over user, nonce and expiry, so Lambda needs no storage. The app requests a token with `requestHash` (plugin `limenia_device`) and posts `platform`, `token`, `ticket` (and `environment: "development"` for iOS debug builds) to `/devices/check`. The token is sent once; network errors, `429` and `5xx` answer `{"status":"unevaluated","deviceFlag":"unknown"}`.
