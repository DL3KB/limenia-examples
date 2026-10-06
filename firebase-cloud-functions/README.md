# Cloud Functions for Firebase

Cloud Functions (2nd gen) between your Firebase app and Limenia. The login is Firebase Authentication: callable functions get the signed-in user from `request.auth`, and the Firebase UID is the `externalUserId` at Limenia. Plain `fetch`, no Limenia SDK.

| Function | Type | Calls Limenia | What it shows |
|---|---|---|---|
| `submitReport` | `onCall` | `POST /v1/reports` | Reporter = caller's UID, `idempotencyKey` in the payload, retries, errors as `HttpsError` |
| `getMyModerationStatus` | `onCall` | `GET /v1/subjects/{uid}/status` | Status of the caller only |
| `requestDeviceHash`, `checkDevice` | `onCall` | `POST /v1/devices/check` | Request hash for `limenia_device`, signed ticket instead of server state, fail-open |
| `limeniaWebhook` | `onRequest` | (called by Limenia) | Signature over `req.rawBody`, dedupe in Firestore, all event types, optional disabling of the Firebase user |

Files in `functions/src/`: `index.js` (the functions), `limenia.js` (HTTP client with retries), `signature.js`, `events.js`, `actions.js` (**placeholders** for your app), `callable.js` (error mapping), `device-ticket.js`.

## Setup

Node.js 22, the Firebase CLI, and a Firebase project on the Blaze plan (secrets and outbound requests need it).

```sh
cd firebase-cloud-functions
firebase use --add                 # pick your project
cd functions
npm install
cp .env.example .env               # base URL and the optional user disabling
firebase functions:secrets:set LIMENIA_API_KEY
firebase functions:secrets:set LIMENIA_WEBHOOK_SECRET
firebase functions:secrets:set DEVICE_CHECK_SECRET   # any random string, e.g. openssl rand -hex 32
npm test
```

| Name | Where | Meaning |
|---|---|---|
| `LIMENIA_BASE_URL` | `functions/.env` | `https://app.limenia.eu` (default), without `/v1` |
| `LIMENIA_API_KEY` | Secret Manager | API key of your app, never in the app |
| `LIMENIA_WEBHOOK_SECRET` | Secret Manager | Secret of your webhook |
| `DEVICE_CHECK_SECRET` | Secret Manager | Signs device check tickets; only your functions know it |
| `LIMENIA_DISABLE_FIREBASE_USERS` | `functions/.env` | `true`: disable the Firebase user on ban and suspension, enable on restore |

The region is set in `src/index.js` (`setGlobalOptions`); pick the one of your project.

## Deploy

```sh
firebase deploy --only functions
```

Then enter the URL of `limeniaWebhook` (shown by the deploy, `https://...cloudfunctions.net/limeniaWebhook` or the Cloud Run URL of the function) as the webhook URL in the Limenia dashboard and use its test button. The function is public (`invoker: "public"`): Limenia has no Google credentials, the signature is the authentication.

In Firestore, add a TTL policy on the field `expireAt` of the collection `limeniaWebhookEvents` to delete old event IDs.

## Calling from the app

```js
import { getFunctions, httpsCallable } from "firebase/functions";

const functions = getFunctions(app, "europe-west3");
const submitReport = httpsCallable(functions, "submitReport");

// Create the key once per report and keep it for retries of the same report.
const idempotencyKey = crypto.randomUUID();
try {
  const { data } = await submitReport({
    reasonCategory: "spam",
    subject: { externalUserId: authorUid },
    content: { externalContentId: "comment_5521", contentType: "comment", text: commentText },
    idempotencyKey,
  });
  if (data.reporterWarning) showWarningAboutUnfoundedReports();
} catch (err) {
  // err.code e.g. "invalid-argument", "permission-denied", "resource-exhausted"
  // err.details: { status, problem, retryAfter } with Limenia's problem body
  if (err.details?.problem?.code === "reporter_suspended") showSuspendedUntil(err.details.problem.suspendedUntil);
}
```

Flutter works the same with `FirebaseFunctions.instanceFor(region: ...).httpsCallable("submitReport")`.

With the emulator (`npm run serve`) a callable can be tried with curl and an ID token of a test user:

```sh
curl -X POST "http://127.0.0.1:5001/<your-project>/europe-west3/getMyModerationStatus" \
  -H "Authorization: Bearer $ID_TOKEN" -H "Content-Type: application/json" -d '{"data":{}}'
```

## How it behaves

**Errors.** `callLimenia` returns Limenia's body on success. Otherwise it throws an `HttpsError` with `details: { status, problem, retryAfter, idempotencyKey }` (the key used, so the app can retry with it): `400` becomes `invalid-argument`, `402` and `409` `failed-precondition`, `403` `permission-denied`, `404` `not-found`, `429` `resource-exhausted`, `5xx` `unavailable`. A `401` from Limenia means the API key is wrong and becomes `internal`, not `unauthenticated`, so the app does not sign the user out.

**Reports.** The function sets `source: "user"` and `reporter.externalUserId` from `request.auth.uid` and passes on only `reasonCategory`, `reasonText`, `subject`, `content` and `externalReportId`. The app sends `idempotencyKey` in the payload (one per report, the same on every retry); without one the function generates `report-<uuid>`.

**Retries.** Network errors, timeouts (30 s), `429` and `5xx` are retried up to five attempts with 1, 2, 4 and 8 s pause, at least `Retry-After`; a `Retry-After` above 30 s goes back to the app. Every attempt sends the same body and key. `submitReport` therefore has a timeout of 120 s; give `httpsCallable` a matching `timeout` option in the app (its default is 70 s).

**Device check.** `requestDeviceHash` returns `{ requestHash, ticket }`. The ticket carries a random nonce, an expiry of 10 minutes and an HMAC over UID, nonce and expiry, so the functions need no storage. The app requests a token with `requestHash` (plugin `limenia_device`), then calls `checkDevice` with `platform`, `token`, `ticket` and, on iOS debug builds, `environment: "development"`. The function recomputes the hash for the caller and sends the token once. Network errors, `429` and `5xx` answer `{"status":"unevaluated","deviceFlag":"unknown"}`, never a reason to reject.

**Webhook.** Signature over `req.rawBody` (300 s tolerance, any `v1`, constant-time comparison), then:

- event IDs already in `limeniaWebhookEvents` are acknowledged without processing; an event is marked processed only after handling
- `decision.created` is applied per `action`; decisions with `reviewId` never change the account, `restore` follows `restoreScope`
- `subject.status_changed`, `appeal.resolved`, `reports.resolved` and `review.decided` call the placeholders; `test.ping` and unknown types get `204`
- the answer comes within 8 s; a failure answers `503`, and Limenia retries

With `LIMENIA_DISABLE_FIREBASE_USERS=true`, `ban_user` and `suspend_user` disable the Firebase user and revoke their refresh tokens; `restore` with `restoreScope: "account"` and `subject.status_changed` to `active` or `warned` enable it again. A suspension ends at `suspendUntil`; `subject.status_changed` can come up to an hour later, so schedule your own re-enable if that matters. Limenia can also do this with its own Firebase connector, set up in the dashboard; then leave this option off.

**Rotating the webhook secret.** Set the new value with `firebase functions:secrets:set LIMENIA_WEBHOOK_SECRET` and redeploy right after rotating in the dashboard. Deliveries that fail in between are retried for about 20 hours.
