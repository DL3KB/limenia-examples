import assert from "node:assert/strict";
import { test } from "node:test";
import { signPayload } from "../src/signature.js";

process.env.GCLOUD_PROJECT ??= "demo-test";
process.env.LIMENIA_WEBHOOK_SECRET = "whsec_test";
const mod = await import("../src/index.js");

test("index.js exports the functions", () => {
  for (const name of ["submitReport", "getMyModerationStatus", "requestDeviceHash", "checkDevice", "limeniaWebhook"]) {
    assert.equal(typeof mod[name], "function", name);
  }
});

function call(handler, { rawBody, signature }) {
  return new Promise((resolve) => {
    const req = { method: "POST", rawBody, headers: {}, get: (h) => (h.toLowerCase() === "limenia-signature" ? signature : undefined) };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
      end() { resolve({ status: this.statusCode }); },
      setHeader() {}, getHeader() {}, on() {},
    };
    handler(req, res);
  });
}

test("webhook verifies the signature over req.rawBody", async () => {
  const rawBody = Buffer.from('{"id":"evt_1","type":"test.ping"}');
  const now = Math.floor(Date.now() / 1000);
  const wrong = await call(mod.limeniaWebhook, { rawBody, signature: signPayload(rawBody, "whsec_wrong", now) });
  assert.deepEqual(wrong, { status: 401, body: { code: "signature_mismatch" } });
  const old = await call(mod.limeniaWebhook, { rawBody, signature: signPayload(rawBody, "whsec_test", now - 400) });
  assert.deepEqual(old, { status: 401, body: { code: "timestamp_out_of_range" } });
});

test("submitReport forwards only externalUserId and displayName of the subject, never identifiers", async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ reportId: "r1" }), { status: 201, headers: { "content-type": "application/json" } });
  };
  process.env.LIMENIA_API_KEY = "lm_test";
  try {
    const subject = { externalUserId: "u_2", displayName: "Eve", identifiers: { emailHmac: "abc", phoneHmac: "def" }, extra: "x" };
    await mod.submitReport.run({ auth: { uid: "u_1" }, data: { reasonCategory: "spam", subject } });
    await mod.submitReport.run({ auth: { uid: "u_1" }, data: { reasonCategory: "spam", subject: { identifiers: { emailHmac: "abc" } } } });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(sent[0].subject, { externalUserId: "u_2", displayName: "Eve" });
  assert.deepEqual(sent[0].reporter, { externalUserId: "u_1" });
  assert.equal(sent[1].subject, undefined);
});
