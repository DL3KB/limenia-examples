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
