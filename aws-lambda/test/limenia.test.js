import assert from "node:assert/strict";
import { test } from "node:test";
import { LimeniaClient, LimeniaUnavailableError, parseRetryAfter } from "../src/limenia.js";

function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers ?? {},
    });
  };
  return { fetch, calls };
}

function client(fetch, sleeps) {
  return new LimeniaClient({
    baseUrl: "https://limenia.test/",
    apiKey: "lm_test_key",
    fetch,
    sleep: async (ms) => sleeps.push(ms),
  });
}

test("retries 503 and network errors with the same key and body", async () => {
  const { fetch, calls } = fakeFetch([new TypeError("fetch failed"), { status: 503 }, { status: 201, body: { reportId: "r1" } }]);
  const sleeps = [];
  const result = await client(fetch, sleeps).request("POST", "/v1/reports", { body: { a: 1 }, idempotencyKey: "k1" });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, { reportId: "r1" });
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.url, "https://limenia.test/v1/reports");
    assert.equal(c.init.headers["Idempotency-Key"], "k1");
    assert.equal(c.init.headers.Authorization, "Bearer lm_test_key");
    assert.equal(c.init.body, '{"a":1}');
  }
});

test("waits at least Retry-After on 429 (up to 30 s)", async () => {
  const { fetch } = fakeFetch([{ status: 429, headers: { "Retry-After": "30" } }, { status: 200, body: {} }]);
  const sleeps = [];
  await client(fetch, sleeps).request("GET", "/v1/ping");
  assert.deepEqual(sleeps, [30000]);
});

test("hands a long Retry-After back instead of waiting", async () => {
  const problem = { type: "about:blank", title: "Too Many Requests", status: 429, code: "rate_limited" };
  const { fetch } = fakeFetch([{ status: 429, headers: { "Retry-After": "31" }, body: problem }]);
  const sleeps = [];
  const result = await client(fetch, sleeps).request("GET", "/v1/ping");
  assert.equal(result.status, 429);
  assert.equal(result.retryAfter, "31");
  assert.equal(result.body.code, "rate_limited");
  assert.deepEqual(sleeps, []);
});

test("does not retry other 4xx", async () => {
  const { fetch, calls } = fakeFetch([{ status: 409, body: { code: "idempotency_key_reused" } }]);
  const result = await client(fetch, []).request("POST", "/v1/reports", { body: {}, idempotencyKey: "k" });
  assert.equal(result.status, 409);
  assert.equal(calls.length, 1);
});

test("gives up after five attempts (waits 1, 2, 4, 8 s)", async () => {
  const { fetch, calls } = fakeFetch(Array.from({ length: 5 }, () => new TypeError("x")));
  const sleeps = [];
  await assert.rejects(client(fetch, sleeps).request("GET", "/v1/ping"), LimeniaUnavailableError);
  assert.equal(calls.length, 5);
  assert.deepEqual(sleeps, [1000, 2000, 4000, 8000]);
});

test("retry: false sends once", async () => {
  const { fetch, calls } = fakeFetch([{ status: 503 }]);
  const result = await client(fetch, []).request("POST", "/v1/devices/check", { body: {}, retry: false });
  assert.equal(result.status, 503);
  assert.equal(calls.length, 1);
});

test("parses Retry-After", () => {
  assert.equal(parseRetryAfter("7"), 7);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 0), 10);
});
