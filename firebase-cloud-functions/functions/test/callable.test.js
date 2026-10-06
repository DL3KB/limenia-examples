import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpsError } from "firebase-functions/v2/https";
import { callLimenia, idempotencyKey } from "../src/callable.js";
import { LimeniaUnavailableError } from "../src/limenia.js";

test("returns the body on success", async () => {
  assert.deepEqual(await callLimenia(async () => ({ status: 201, body: { reportId: "r" } })), { reportId: "r" });
});

test("maps a problem to an HttpsError with status, problem and Retry-After in details", async () => {
  const problem = { type: "about:blank", title: "Too Many Requests", status: 429, code: "rate_limited" };
  await assert.rejects(callLimenia(async () => ({ status: 429, body: problem, retryAfter: "30" })), (err) => {
    assert.ok(err instanceof HttpsError);
    assert.equal(err.code, "resource-exhausted");
    assert.deepEqual(err.details, { status: 429, problem, retryAfter: "30", idempotencyKey: undefined });
    return true;
  });
});

test("reporter_suspended keeps suspendedUntil for the app", async () => {
  const problem = { status: 403, code: "reporter_suspended", suspendedUntil: "2026-11-01T00:00:00Z" };
  await assert.rejects(callLimenia(async () => ({ status: 403, body: problem, retryAfter: null })), (err) => {
    assert.equal(err.code, "permission-denied");
    assert.equal(err.details.problem.suspendedUntil, "2026-11-01T00:00:00Z");
    return true;
  });
});

test("401 from Limenia is an internal error, unreachable is unavailable", async () => {
  await assert.rejects(callLimenia(async () => ({ status: 401, body: {} })), (err) => err.code === "internal");
  await assert.rejects(callLimenia(async () => { throw new LimeniaUnavailableError(); }), (err) => err.code === "unavailable");
});

test("the app's idempotency key is passed through, otherwise generated", () => {
  assert.equal(idempotencyKey("report", "report-7f3c9a"), "report-7f3c9a");
  assert.match(idempotencyKey("report", undefined), /^report-[0-9a-f-]{36}$/);
});

test("the key used comes back in the details", async () => {
  await assert.rejects(callLimenia(async () => ({ status: 503, body: null, retryAfter: null }), { idempotencyKey: "k1" }), (err) => {
    assert.equal(err.code, "unavailable");
    assert.equal(err.details.idempotencyKey, "k1");
    return true;
  });
});
