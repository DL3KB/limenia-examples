import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApp } from "../src/app.js";
import { deviceRequestHash } from "../src/device.js";
import { signPayload } from "../src/signature.js";

const SECRET = "whsec_test";
const done = []; // actions performed
const actions = new Proxy({}, { get: (_, name) => async (...args) => done.push([name, ...args]) });

const limeniaCalls = [];
let nextLimeniaResult = { status: 201, body: {}, retryAfter: null };
const limenia = {
  async request(method, path, options = {}) {
    limeniaCalls.push({ method, path, ...options });
    return nextLimeniaResult;
  },
};

let server;
let base;
before(async () => {
  server = createApp({ limenia, webhookSecrets: [SECRET], actions }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function deliver(event, { secret = SECRET, t = Math.floor(Date.now() / 1000) } = {}) {
  const body = JSON.stringify(event);
  return fetch(`${base}/limenia/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Limenia-Signature": signPayload(body, secret, t) },
    body,
  });
}

const app = { id: "app_1", slug: "demo" };
const decision = (id, fields) => ({
  id,
  type: "decision.created",
  createdAt: "2026-10-01T10:00:00.123456Z",
  app,
  decision: { id: `dec_${id}`, policies: [], statementOfReasons: { text: "..." }, decidedAt: "2026-10-01T10:00:00.123456Z", ...fields },
});

test("webhook: rejects a bad signature with 401", async () => {
  const res = await deliver({ id: "evt_bad", type: "test.ping", app }, { secret: "whsec_wrong" });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "signature_mismatch");
});

test("webhook: rejects an old timestamp with 401", async () => {
  const res = await deliver({ id: "evt_old", type: "test.ping", app }, { t: Math.floor(Date.now() / 1000) - 600 });
  assert.equal(res.status, 401);
});

test("webhook: applies a ban once, duplicates are acknowledged", async () => {
  done.length = 0;
  const event = decision("evt_ban", { action: "ban_user", subject: { externalUserId: "u_1" } });
  assert.equal((await deliver(event)).status, 204);
  assert.equal((await deliver(event)).status, 204);
  assert.deepEqual(done.map((d) => d[0]), ["banUser", "notifyAffectedUser"]);
});

test("webhook: decisions with reviewId never touch the account", async () => {
  done.length = 0;
  await deliver(decision("evt_rev1", { action: "reject_submission", reviewId: "rev_1", subject: { externalUserId: "u_2" }, content: { externalContentId: "photo_1" } }));
  await deliver(decision("evt_rev2", { action: "restore", restoreScope: "content", reviewId: "rev_1", subject: { externalUserId: "u_2" }, content: { externalContentId: "photo_2" } }));
  const names = done.map((d) => d[0]);
  assert.deepEqual(names, ["rejectSubmission", "notifyAffectedUser", "publishSubmission", "notifyAffectedUser"]);
});

test("webhook: a late, older decision does not override a newer one", async () => {
  done.length = 0;
  const restore = decision("evt_new", { action: "restore", restoreScope: "account", subject: { externalUserId: "u_3" }, decidedAt: "2026-10-02T00:00:00Z" });
  const suspend = decision("evt_late", { action: "suspend_user", suspendUntil: "2026-10-09T00:00:00Z", subject: { externalUserId: "u_3" }, decidedAt: "2026-10-01T00:00:00.5Z" });
  await deliver(restore);
  await deliver(suspend);
  assert.deepEqual(done.map((d) => d[0]), ["restoreAccount", "notifyAffectedUser"]);
});

test("webhook: other event types and unknown types get 2xx", async () => {
  done.length = 0;
  const events = [
    { id: "evt_s", type: "subject.status_changed", createdAt: "2026-10-08T08:15:02Z", app, subject: { externalUserId: "u_4", status: "active" } },
    { id: "evt_a", type: "appeal.resolved", createdAt: "2026-10-05T09:00:00Z", app, appeal: { id: "ap_1", outcome: "upheld", statementText: "..." } },
    { id: "evt_r", type: "reports.resolved", createdAt: "2026-10-01T10:00:00Z", app, reports: { decisionId: "d", action: "dismiss", items: [{ reportId: "r" }] } },
    { id: "evt_v", type: "review.decided", createdAt: "2026-10-03T09:12:00Z", app, review: { id: "rv", outcome: "approved", decidedAt: "2026-10-03T09:12:00Z", content: { externalContentId: "photo_9" } } },
    { id: "evt_x", type: "something.new", createdAt: "2026-10-03T09:12:00Z", app },
  ];
  for (const e of events) assert.equal((await deliver(e)).status, 204);
  assert.deepEqual(done.map((d) => d[0]), ["setAccountStatus", "notifyAppellant", "notifyReporters", "publishSubmission"]);
});

test("report: reporter from the login, Idempotency-Key passed through and echoed, Limenia's problem and Retry-After forwarded", async () => {
  limeniaCalls.length = 0;
  nextLimeniaResult = { status: 429, retryAfter: "30", body: { type: "about:blank", title: "Too Many Requests", status: 429, code: "rate_limited" } };
  const res = await fetch(`${base}/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": "u_829", "Idempotency-Key": "report-7f3c9a" },
    body: JSON.stringify({ reasonCategory: "spam", reporter: { externalUserId: "someone_else" }, source: "system", subject: { externalUserId: "u_112" } }),
  });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "30");
  assert.match(res.headers.get("content-type"), /application\/problem\+json/);
  assert.equal((await res.json()).code, "rate_limited");
  const call = limeniaCalls[0];
  assert.equal(call.path, "/v1/reports");
  assert.equal(call.body.source, "user");
  assert.deepEqual(call.body.reporter, { externalUserId: "u_829" });
  assert.equal(call.idempotencyKey, "report-7f3c9a");
  assert.equal(res.headers.get("idempotency-key"), "report-7f3c9a");
});

test("report: requires a login", async () => {
  const res = await fetch(`${base}/reports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
});

test("status: only for the signed-in user", async () => {
  limeniaCalls.length = 0;
  nextLimeniaResult = { status: 200, retryAfter: null, body: { externalUserId: "a/b", status: "active" } };
  const res = await fetch(`${base}/me/moderation-status`, { headers: { "X-User-Id": "a/b" } });
  assert.equal(res.status, 200);
  assert.equal(limeniaCalls[0].path, "/v1/subjects/a%2Fb/status");
});

test("appeal status: only for the person who complained", async () => {
  nextLimeniaResult = { status: 201, retryAfter: null, body: { appealId: "ap_7", status: "open" } };
  await fetch(`${base}/appeals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": "u_1" },
    body: JSON.stringify({ decisionId: "01K6G5H1TR8W4QZ3M0XCB7NDEC", appellantType: "subject", text: "..." }),
  });
  assert.deepEqual(limeniaCalls.at(-1).body.appellant, { type: "subject", externalUserId: "u_1" });
  nextLimeniaResult = { status: 200, retryAfter: null, body: { id: "ap_7", status: "open" } };
  assert.equal((await fetch(`${base}/appeals/ap_7`, { headers: { "X-User-Id": "u_2" } })).status, 404);
  assert.equal((await fetch(`${base}/appeals/ap_7`, { headers: { "X-User-Id": "u_1" } })).status, 200);
});

test("device check: hash kept for this user, used once; fail open on 5xx", async () => {
  const headers = { "Content-Type": "application/json", "X-User-Id": "u_112" };
  const { requestHash } = await (await fetch(`${base}/devices/request-hash`, { method: "POST", headers })).json();
  assert.match(requestHash, /^[A-Za-z0-9_-]{43}$/);

  const body = JSON.stringify({ platform: "android", token: "tok", event: "login" });
  const other = await fetch(`${base}/devices/check`, { method: "POST", headers: { ...headers, "X-User-Id": "u_999" }, body });
  assert.equal(other.status, 400);

  limeniaCalls.length = 0;
  nextLimeniaResult = { status: 200, retryAfter: null, body: { checkId: "c1", status: "evaluated", deviceFlag: "none" } };
  const ok = await fetch(`${base}/devices/check`, { method: "POST", headers, body });
  assert.equal(ok.status, 200);
  assert.deepEqual(limeniaCalls[0].body, { externalUserId: "u_112", platform: "android", token: "tok", requestHash, event: "login" });
  assert.equal(limeniaCalls[0].retry, false);

  const replay = await fetch(`${base}/devices/check`, { method: "POST", headers, body });
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).code, "request_hash_missing");

  nextLimeniaResult = { status: 503, retryAfter: null, body: null };
  const ios = await fetch(`${base}/devices/check`, { method: "POST", headers, body: JSON.stringify({ platform: "ios", token: "dc", environment: "development" }) });
  assert.deepEqual(await ios.json(), { status: "unevaluated", deviceFlag: "unknown" });
});

test("request hash follows the documented formula", () => {
  // base64url(SHA-256("limenia:" + externalUserId + ":" + nonce)) without padding, computed independently
  assert.equal(deviceRequestHash("u_112", "n1"), "CvuBqutH7GhuMXcNutV-bLyiJT3vYP7VCiBMg5Z5Zzg");
});
