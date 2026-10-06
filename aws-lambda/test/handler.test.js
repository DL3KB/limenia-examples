import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandler } from "../src/handler.js";
import { signPayload } from "../src/signature.js";

const SECRET = "whsec_test";
const env = { LIMENIA_WEBHOOK_SECRET: SECRET, DEVICE_CHECK_SECRET: "devsecret", LIMENIA_API_KEY: "k" };

function setup(limeniaResult = { status: 201, body: {}, retryAfter: null }) {
  const calls = [];
  const done = [];
  const limenia = { request: async (method, path, options = {}) => (calls.push({ method, path, ...options }), limeniaResult) };
  const actions = new Proxy({}, { get: (_, name) => async (...args) => done.push([name, ...args]) });
  const seen = new Set();
  const store = { isProcessed: async (id) => seen.has(id), markProcessed: async (id) => void seen.add(id) };
  return { calls, done, handler: createHandler({ env, limenia, actions, store }) };
}

const httpEvent = (method, rawPath, { body, headers = {}, base64 = false } = {}) => ({
  version: "2.0",
  rawPath,
  headers,
  requestContext: { http: { method, path: rawPath } },
  body: body === undefined ? undefined : base64 ? Buffer.from(body).toString("base64") : body,
  isBase64Encoded: base64,
});

function webhookEvent(payload, { secret = SECRET, base64 = false, t = Math.floor(Date.now() / 1000) } = {}) {
  const body = JSON.stringify(payload);
  return httpEvent("POST", "/limenia/webhook", { body, base64, headers: { "content-type": "application/json", "limenia-signature": signPayload(body, secret, t) } });
}

test("webhook: verifies a base64-encoded raw body and dedupes", async () => {
  const { handler, done } = setup();
  const payload = { id: "evt_1", type: "decision.created", app: { id: "a", slug: "s" }, decision: { id: "d", action: "suspend_user", suspendUntil: "2026-10-08T08:00:00Z", subject: { externalUserId: "u_1" }, policies: [], statementOfReasons: { text: "" }, decidedAt: "2026-10-01T10:00:00Z" } };
  assert.equal((await handler(webhookEvent(payload, { base64: true }))).statusCode, 204);
  assert.equal((await handler(webhookEvent(payload))).statusCode, 204);
  assert.deepEqual(done.map((d) => d[0]), ["suspendUser", "notifyAffectedUser"]);
});

test("webhook: wrong secret, old timestamp and tampered body get 401", async () => {
  const { handler } = setup();
  const payload = { id: "evt_2", type: "test.ping" };
  assert.equal((await handler(webhookEvent(payload, { secret: "whsec_wrong" }))).statusCode, 401);
  assert.equal((await handler(webhookEvent(payload, { t: Math.floor(Date.now() / 1000) - 301 }))).statusCode, 401);
  const tampered = webhookEvent(payload);
  tampered.body = tampered.body.replace("evt_2", "evt_3");
  assert.equal((await handler(tampered)).statusCode, 401);
});

test("webhook: unknown event types get 2xx", async () => {
  const { handler } = setup();
  assert.equal((await handler(webhookEvent({ id: "evt_9", type: "brand.new" }))).statusCode, 204);
});

test("report: reporter from the login, key echoed, problem and Retry-After forwarded", async () => {
  const problem = { type: "about:blank", title: "Bad Request", status: 400, code: "validation_failed", errors: [{ field: "/reasonCategory", code: "required" }] };
  const { handler, calls } = setup({ status: 400, body: problem, retryAfter: null });
  const res = await handler(httpEvent("POST", "/reports", { body: JSON.stringify({ reporter: { externalUserId: "x" }, subject: { externalUserId: "u_112" } }), headers: { "x-user-id": "u_829", "idempotency-key": "abc" } }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers["content-type"], "application/problem+json");
  assert.deepEqual(JSON.parse(res.body), problem);
  assert.deepEqual(calls[0].body.reporter, { externalUserId: "u_829" });
  assert.equal(calls[0].body.source, "user");
  assert.equal(calls[0].idempotencyKey, "abc");
  assert.equal(res.headers["idempotency-key"], "abc");

  const limited = setup({ status: 429, body: { status: 429, code: "rate_limited" }, retryAfter: "20" });
  const res429 = await limited.handler(httpEvent("POST", "/reports", { body: "{}", headers: { "x-user-id": "u" } }));
  assert.equal(res429.statusCode, 429);
  assert.equal(res429.headers["retry-after"], "20");
});

test("app routes need a user; JWT authorizer claims win", async () => {
  const { handler, calls } = setup({ status: 200, body: { externalUserId: "cog_1", status: "active" }, retryAfter: null });
  assert.equal((await handler(httpEvent("GET", "/me/moderation-status"))).statusCode, 401);
  const e = httpEvent("GET", "/me/moderation-status", { headers: { "x-user-id": "spoofed" } });
  e.requestContext.authorizer = { jwt: { claims: { sub: "cog_1" } } };
  assert.equal((await handler(e)).statusCode, 200);
  assert.equal(calls[0].path, "/v1/subjects/cog_1/status");
});

test("device check: ticket of the same user, sent once, fail open", async () => {
  const { handler, calls } = setup({ status: 502, body: null, retryAfter: null });
  const headers = { "x-user-id": "u_112" };
  const start = JSON.parse((await handler(httpEvent("POST", "/devices/request-hash", { headers }))).body);
  const body = JSON.stringify({ platform: "android", token: "tok", ticket: start.ticket, event: "login" });
  assert.equal((await handler(httpEvent("POST", "/devices/check", { body, headers: { "x-user-id": "other" } }))).statusCode, 400);
  const res = await handler(httpEvent("POST", "/devices/check", { body, headers }));
  assert.deepEqual(JSON.parse(res.body), { status: "unevaluated", deviceFlag: "unknown" });
  assert.deepEqual(calls[0].body, { externalUserId: "u_112", platform: "android", token: "tok", requestHash: start.requestHash, event: "login" });
  assert.equal(calls[0].retry, false);
});
