import { assertEquals } from "jsr:@std/assert@1";
import { banDuration } from "../_shared/actions.ts";
import type { Actions, EventStore } from "../_shared/events.ts";
import { createDevicesHandler, createReportsHandler, createWebhookHandler } from "../_shared/handlers.ts";
import type { LimeniaResult, RequestOptions } from "../_shared/limenia.ts";
import { signPayload } from "../_shared/signature.ts";

const SECRET = "whsec_test";

function fakeLimenia(result: LimeniaResult) {
  const calls: ({ method: string; path: string } & RequestOptions)[] = [];
  return {
    calls,
    limenia: {
      request: (
        method: string,
        path: string,
        options: RequestOptions = {},
      ) => (calls.push({ method, path, ...options }), Promise.resolve(result)),
    },
  };
}
// Test login: the bearer token is the user ID.
const userFromRequest = (req: Request) => Promise.resolve(req.headers.get("authorization")?.replace("Bearer ", "") ?? null);

function webhookSetup() {
  const done: string[] = [];
  const actions = new Proxy({}, { get: (_, name) => () => (done.push(String(name)), Promise.resolve()) }) as Actions;
  const seen = new Set<string>();
  const store: EventStore = {
    isProcessed: (id) => Promise.resolve(seen.has(id)),
    markProcessed: (id) => (seen.add(id), Promise.resolve()),
  };
  return { done, handler: createWebhookHandler({ secrets: [SECRET], store, actions }) };
}

async function deliver(handler: (req: Request) => Promise<Response>, event: unknown, secret = SECRET, t = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(event);
  return handler(
    new Request("http://localhost/limenia-webhook", {
      method: "POST",
      body,
      headers: { "limenia-signature": await signPayload(body, secret, t) },
    }),
  );
}

Deno.test("webhook: ban applied once, duplicate acknowledged", async () => {
  const { done, handler } = webhookSetup();
  const event = {
    id: "evt_1",
    type: "decision.created",
    decision: { id: "d", action: "ban_user", subject: { externalUserId: "u" }, decidedAt: "2026-10-01T10:00:00Z" },
  };
  assertEquals((await deliver(handler, event)).status, 204);
  assertEquals((await deliver(handler, event)).status, 204);
  assertEquals(done, ["banUser", "notifyAffectedUser"]);
});

Deno.test("webhook: decisions with reviewId only touch content", async () => {
  const { done, handler } = webhookSetup();
  await deliver(handler, {
    id: "e1",
    type: "decision.created",
    decision: {
      id: "d1",
      action: "reject_submission",
      reviewId: "rv",
      subject: { externalUserId: "u" },
      content: { externalContentId: "c" },
      decidedAt: "x",
    },
  });
  await deliver(handler, {
    id: "e2",
    type: "decision.created",
    decision: {
      id: "d2",
      action: "restore",
      restoreScope: "content",
      reviewId: "rv",
      subject: { externalUserId: "u" },
      content: { externalContentId: "c" },
      decidedAt: "x",
    },
  });
  assertEquals(done.filter((n) => n !== "notifyAffectedUser"), ["rejectSubmission", "publishSubmission"]);
});

Deno.test("webhook: bad signature, old timestamp and tampered body get 401", async () => {
  const { handler } = webhookSetup();
  assertEquals((await deliver(handler, { id: "e", type: "test.ping" }, "whsec_wrong")).status, 401);
  assertEquals((await deliver(handler, { id: "e", type: "test.ping" }, SECRET, Math.floor(Date.now() / 1000) - 301)).status, 401);
  const header = await signPayload('{"id":"e"}', SECRET, Math.floor(Date.now() / 1000));
  const tampered = await handler(
    new Request("http://localhost/x", { method: "POST", body: '{"id":"f"}', headers: { "limenia-signature": header } }),
  );
  assertEquals(tampered.status, 401);
});

Deno.test("webhook: test.ping and unknown types get 204", async () => {
  const { handler } = webhookSetup();
  assertEquals((await deliver(handler, { id: "p", type: "test.ping" })).status, 204);
  assertEquals((await deliver(handler, { id: "n", type: "brand.new" })).status, 204);
});

Deno.test("report: reporter from the login, key passed through and echoed, problem and Retry-After forwarded", async () => {
  const problem = { type: "about:blank", title: "Too Many Requests", status: 429, code: "rate_limited" };
  const { calls, limenia } = fakeLimenia({ status: 429, body: problem, retryAfter: "40" });
  const handler = createReportsHandler({ limenia, userFromRequest });
  const res = await handler(
    new Request("http://localhost/limenia-reports", {
      method: "POST",
      headers: { authorization: "Bearer u_829", "idempotency-key": "report-7f3c9a" },
      body: JSON.stringify({
        reasonCategory: "spam",
        source: "system",
        reporter: { externalUserId: "x" },
        subject: { externalUserId: "u_112" },
      }),
    }),
  );
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("retry-after"), "40");
  assertEquals(res.headers.get("idempotency-key"), "report-7f3c9a");
  assertEquals(await res.json(), problem);
  assertEquals((calls[0].body as Record<string, unknown>).reporter, { externalUserId: "u_829" });
  assertEquals((calls[0].body as Record<string, unknown>).source, "user");
  assertEquals(calls[0].idempotencyKey, "report-7f3c9a");
  assertEquals((await handler(new Request("http://localhost/limenia-reports", { method: "POST", body: "{}" }))).status, 401);
});

Deno.test("devices: ticket of the same user, sent once without retry, fail open", async () => {
  const { calls, limenia } = fakeLimenia({ status: 503, body: null, retryAfter: null });
  const handler = createDevicesHandler({ limenia, userFromRequest, deviceSecret: "s" });
  const post = (path: string, user: string, body?: unknown) =>
    handler(
      new Request(`http://localhost/limenia-devices${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${user}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const { requestHash, ticket } = await (await post("/request-hash", "u_112")).json();
  assertEquals((await post("/check", "u_999", { platform: "android", token: "t", ticket })).status, 400);
  const res = await post("/check", "u_112", { platform: "android", token: "t", ticket, event: "login" });
  assertEquals(await res.json(), { status: "unevaluated", deviceFlag: "unknown" });
  assertEquals(calls[0].body, { externalUserId: "u_112", platform: "android", token: "t", requestHash, event: "login" });
  assertEquals(calls[0].retry, false);
});

Deno.test("ban_duration for Supabase Auth", () => {
  assertEquals(banDuration(undefined), "876000h");
  assertEquals(banDuration("2026-10-08T08:00:00Z", Date.parse("2026-10-08T06:30:00Z")), "2h");
  assertEquals(banDuration("2026-10-01T00:00:00Z", Date.parse("2026-10-08T00:00:00Z")), "none");
});
