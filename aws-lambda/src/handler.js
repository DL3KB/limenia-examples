// AWS Lambda (Node.js 20) for a Function URL or an API Gateway HTTP API
// (payload format 2.0). One function, routed by method and path.
//
//   POST /reports                 report content or a user   -> POST /v1/reports
//   GET  /me/moderation-status    own status                 -> GET  /v1/subjects/{id}/status
//   POST /devices/request-hash    request hash and ticket for the device check
//   POST /devices/check           forward the device token   -> POST /v1/devices/check
//   POST /limenia/webhook         webhook receiver (called by Limenia)

import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { actions as defaultActions } from "./actions.js";
import { issueDeviceTicket, redeemDeviceTicket } from "./device-ticket.js";
import { dynamoEventStore, memoryEventStore } from "./event-store.js";
import { handleEvent } from "./events.js";
import { LimeniaClient, LimeniaUnavailableError } from "./limenia.js";
import { verifySignature, WebhookSignatureError } from "./signature.js";

// ---------------------------------------------------------------------------
// AUTH STUB: REPLACE WITH YOUR LOGIN.
// With an API Gateway HTTP API and a JWT authorizer (e.g. Amazon Cognito) the
// verified user ID is in the claims. The header X-User-Id is for trying the
// example only; anyone can send it, so it is refused in production.
// The ID must come from your login, never from the request body.
// ---------------------------------------------------------------------------
function currentUserId(event) {
  const sub = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (sub) return String(sub);
  if (process.env.NODE_ENV === "production") return null;
  const id = event.headers?.["x-user-id"];
  return id && id.length <= 128 ? id : null;
}

/** The raw body as bytes. Lambda may hand it over base64-encoded. */
export function rawBody(event) {
  if (!event.body) return Buffer.alloc(0);
  return Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8");
}

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const problem = (status, code, detail, headers = {}) =>
  json(status, { type: "about:blank", title: STATUS_CODES[status], status, code, detail }, { ...headers, "content-type": "application/problem+json" });

/** Passes Limenia's status, problem body and Retry-After on to the app. */
async function forward(call, extraHeaders = {}) {
  let result;
  try {
    result = await call();
  } catch (err) {
    if (err instanceof LimeniaUnavailableError) return problem(502, "limenia_unreachable", "Limenia could not be reached.", extraHeaders);
    throw err;
  }
  const headers = { ...extraHeaders, ...(result.retryAfter ? { "retry-after": result.retryAfter } : {}) };
  // Note: a 401 from Limenia means the backend's API key is wrong, not that the app user
  // is signed out. Do not sign the user out in the app because of it.
  if (result.status >= 400) {
    const body = result.body ?? { type: "about:blank", title: "Upstream Error", status: result.status, code: "upstream_error" };
    return json(result.status, body, { ...headers, "content-type": "application/problem+json" });
  }
  return json(result.status, result.body, headers);
}

// The app should create one key per report and send it again on every retry. Without
// one, a key is made here; it then only covers our own retries. It is echoed back.
function idempotencyKey(event, kind) {
  const fromApp = event.headers?.["idempotency-key"];
  return fromApp && fromApp.length <= 200 ? fromApp : `${kind}-${randomUUID()}`;
}

export function createHandler({ env = process.env, limenia, actions = defaultActions, store } = {}) {
  // API Gateway HTTP APIs end requests after 30 s, so this uses a shorter timeout,
  // fewer attempts and a lower Retry-After limit than the other examples.
  limenia ??= new LimeniaClient({ baseUrl: env.LIMENIA_BASE_URL || "https://app.limenia.eu", apiKey: env.LIMENIA_API_KEY, timeoutMs: 12_000, maxAttempts: 2, maxWaitSeconds: 5 });
  const secrets = [env.LIMENIA_WEBHOOK_SECRET, env.LIMENIA_WEBHOOK_SECRET_PREVIOUS].filter(Boolean);
  let storePromise = store ? Promise.resolve(store) : null;
  const eventStore = () => (storePromise ??= env.LIMENIA_EVENTS_TABLE ? dynamoEventStore(env.LIMENIA_EVENTS_TABLE) : Promise.resolve(memoryEventStore()));

  async function webhook(event) {
    const body = rawBody(event);
    try {
      verifySignature({ header: event.headers?.["limenia-signature"], rawBody: body, secrets });
    } catch (err) {
      if (err instanceof WebhookSignatureError) return json(401, { code: err.code });
      throw err;
    }
    let payload;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return json(400, { code: "invalid_body" });
    }
    try {
      const result = await withDeadline(handleEvent(payload, { store: await eventStore(), actions }), 8_000);
      console.log(JSON.stringify({ msg: "webhook", eventId: payload.id, type: payload.type, result }));
      return { statusCode: 204 };
    } catch (err) {
      console.error(JSON.stringify({ msg: "webhook failed", eventId: payload.id, error: String(err?.message ?? err) }));
      return { statusCode: 503 }; // Limenia retries
    }
  }

  return async function handler(event) {
    const method = event.requestContext?.http?.method;
    const path = event.rawPath;
    if (method === "POST" && path === "/limenia/webhook") return webhook(event);

    const userId = currentUserId(event);
    if (!userId) return problem(401, "unauthenticated", "Sign in first.");
    let body = {};
    if (method === "POST") {
      try {
        body = JSON.parse(rawBody(event).toString("utf8") || "{}");
      } catch {
        return problem(400, "bad_request", "Invalid JSON.");
      }
    }

    if (method === "POST" && path === "/reports") {
      const report = {
        source: "user",
        reasonCategory: body.reasonCategory,
        reasonText: body.reasonText,
        reporter: { externalUserId: userId }, // from the login, never from the app
        // Better: load the content and its author from your database by ID.
        subject: body.subject,
        content: body.content,
        externalReportId: body.externalReportId,
      };
      const key = idempotencyKey(event, "report");
      return forward(() => limenia.request("POST", "/v1/reports", { body: report, idempotencyKey: key }), { "idempotency-key": key });
    }

    if (method === "GET" && path === "/me/moderation-status") {
      return forward(() => limenia.request("GET", `/v1/subjects/${encodeURIComponent(userId)}/status`));
    }

    if (method === "POST" && path === "/devices/request-hash") {
      return json(200, issueDeviceTicket(userId, env.DEVICE_CHECK_SECRET));
    }

    if (method === "POST" && path === "/devices/check") {
      const { platform, token, ticket, environment, event: checkEvent } = body;
      const check = { externalUserId: userId, platform, token, event: checkEvent };
      if (platform === "android") {
        const requestHash = redeemDeviceTicket(ticket, userId, env.DEVICE_CHECK_SECRET);
        if (!requestHash) return problem(400, "request_hash_missing", "Request a hash first.");
        check.requestHash = requestHash;
      }
      if (platform === "ios" && environment) check.environment = environment;
      const unevaluated = json(200, { status: "unevaluated", deviceFlag: "unknown" });
      // Sent once: the token is single-use. Network errors, 429 and 5xx count as unevaluated (fail open).
      let result;
      try {
        result = await limenia.request("POST", "/v1/devices/check", { body: check, retry: false });
      } catch (err) {
        if (err instanceof LimeniaUnavailableError) return unevaluated;
        throw err;
      }
      if (result.status === 429 || result.status >= 500) return unevaluated;
      // Decide here what follows; this example returns Limenia's answer.
      return forward(async () => result);
    }

    return problem(404, "not_found", "Unknown route.");
  };
}

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("deadline exceeded")), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

let cached;
export const handler = (event) => (cached ??= createHandler())(event);
