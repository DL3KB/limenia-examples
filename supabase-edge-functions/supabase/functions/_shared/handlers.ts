// Request handlers of the four functions. Each index.ts wires them to Deno.serve;
// the tests call them with fakes.

import { issueDeviceTicket, redeemDeviceTicket } from "./device-ticket.ts";
import { type Actions, type EventStore, handleEvent, type WebhookEvent } from "./events.ts";
import { corsHeaders, forward, idempotencyKey, json, problem } from "./http.ts";
import { type LimeniaApi, type LimeniaResult, LimeniaUnavailableError } from "./limenia.ts";
import { verifySignature, WebhookSignatureError } from "./signature.ts";

type Handler = (req: Request) => Promise<Response>;
type UserResolver = (req: Request) => Promise<string | null>;

/** CORS preflight, method check and the signed-in user. */
function appRoute(method: string, userFromRequest: UserResolver, handle: (req: Request, userId: string) => Promise<Response>): Handler {
  return async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (req.method !== method) return problem(405, "method_not_allowed", "Method not allowed");
    const userId = await userFromRequest(req);
    if (!userId) return problem(401, "unauthenticated", "Not signed in");
    return handle(req, userId);
  };
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

// POST limenia-reports: report content or a user. The reporter is the signed-in user.
export function createReportsHandler(deps: { limenia: LimeniaApi; userFromRequest: UserResolver }): Handler {
  return appRoute("POST", deps.userFromRequest, async (req, userId) => {
    const b = await readJson(req);
    if (!b) return problem(400, "bad_request", "Body must be a JSON object");
    const report = {
      source: "user",
      reasonCategory: b.reasonCategory,
      reasonText: b.reasonText,
      reporter: { externalUserId: userId }, // from the login, never from the app
      // The reported user (for content: its author). Better: load the content and its
      // author from your tables by ID instead of trusting what the app sends.
      subject: b.subject,
      content: b.content,
      externalReportId: b.externalReportId,
    };
    const key = idempotencyKey(req, "report");
    return forward(() => deps.limenia.request("POST", "/v1/reports", { body: report, idempotencyKey: key }), { "idempotency-key": key });
  });
}

// GET limenia-moderation-status: status of the signed-in user (and only of them).
export function createStatusHandler(deps: { limenia: LimeniaApi; userFromRequest: UserResolver }): Handler {
  return appRoute(
    "GET",
    deps.userFromRequest,
    (_req, userId) => forward(() => deps.limenia.request("GET", `/v1/subjects/${encodeURIComponent(userId)}/status`)),
  );
}

// POST limenia-devices/request-hash, then POST limenia-devices/check.
export function createDevicesHandler(deps: { limenia: LimeniaApi; userFromRequest: UserResolver; deviceSecret: string }): Handler {
  return appRoute("POST", deps.userFromRequest, async (req, userId) => {
    const path = new URL(req.url).pathname;

    if (path.endsWith("/request-hash")) {
      // Step 1: { requestHash, ticket }. The app requests a token with requestHash (limenia_device).
      return json(200, await issueDeviceTicket(userId, deps.deviceSecret));
    }
    if (!path.endsWith("/check")) return problem(404, "not_found", "Unknown route");

    // Step 2: { platform, token, ticket, event?, environment? }
    const b = await readJson(req);
    if (!b) return problem(400, "bad_request", "Body must be a JSON object");
    const check: Record<string, unknown> = { externalUserId: userId, platform: b.platform, token: b.token, event: b.event };
    if (b.platform === "android") {
      const requestHash = await redeemDeviceTicket(b.ticket, userId, deps.deviceSecret);
      if (!requestHash) return problem(400, "request_hash_missing", "Request a hash first");
      check.requestHash = requestHash;
    }
    if (b.platform === "ios" && b.environment) check.environment = b.environment;

    // No retry: a device token is single-use.
    let result: LimeniaResult | null = null;
    try {
      result = await deps.limenia.request("POST", "/v1/devices/check", { body: check, retry: false });
    } catch (err) {
      if (!(err instanceof LimeniaUnavailableError)) throw err;
    }
    if (!result || result.status === 429 || result.status >= 500) {
      // Fail open. Never reject a login because the check could not run.
      return json(200, { status: "unevaluated", deviceFlag: "unknown" });
    }
    // Decide here what follows (e.g. hold a registration on deviceFlag "banned"); this returns Limenia's answer.
    const answer = result;
    return forward(() => Promise.resolve(answer));
  });
}

// POST limenia-webhook: called by Limenia. Deploy with --no-verify-jwt.
export function createWebhookHandler(deps: { secrets: string[]; store: EventStore; actions: Actions }): Handler {
  return async (req) => {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    // The exact bytes Limenia signed. Never verify JSON.stringify(await req.json()).
    const rawBody = new Uint8Array(await req.arrayBuffer());
    try {
      await verifySignature({ header: req.headers.get("limenia-signature"), rawBody, secrets: deps.secrets });
    } catch (err) {
      if (err instanceof WebhookSignatureError) return Response.json({ code: err.code }, { status: 401 });
      throw err;
    }
    let event: WebhookEvent;
    try {
      event = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return Response.json({ code: "invalid_body" }, { status: 400 });
    }
    try {
      const result = await withDeadline(handleEvent(event, deps), 8_000); // Limenia waits 10 s
      console.log(JSON.stringify({ msg: "webhook", eventId: event.id, type: event.type, result }));
      return new Response(null, { status: 204 });
    } catch (err) {
      console.error(JSON.stringify({ msg: "webhook failed", eventId: event.id, error: String((err as Error)?.message ?? err) }));
      return new Response(null, { status: 503 }); // Limenia retries
    }
  };
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("deadline exceeded")), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
