import assert from "node:assert/strict";
import { test } from "node:test";
import { signPayload, verifySignature, WebhookSignatureError } from "../src/signature.js";

// Test vector of the Limenia webhook documentation.
const SECRET = "whsec_test";
const T = 1800000000;
const BODY = '{"id":"evt_1"}';
const V1 = "45705be2a45ab5acdd1395cc695e9e7073125385ec24194921c401dff44176f8";
const HEADER = `t=${T},v1=${V1}`;

const fails = (args, code) =>
  assert.throws(() => verifySignature({ now: T, secrets: [SECRET], rawBody: BODY, header: HEADER, ...args }), (err) => {
    assert.ok(err instanceof WebhookSignatureError);
    assert.equal(err.code, code);
    return true;
  });

test("accepts the test vector", () => {
  verifySignature({ header: HEADER, rawBody: Buffer.from(BODY), secrets: [SECRET], now: T });
  assert.equal(signPayload(BODY, SECRET, T), HEADER);
});

test("rejects a wrong secret", () => fails({ secrets: ["whsec_wrong"] }, "signature_mismatch"));

test("rejects an old timestamp", () => fails({ now: T + 301 }, "timestamp_out_of_range"));

test("rejects a timestamp too far in the future", () => fails({ now: T - 301 }, "timestamp_out_of_range"));

test("accepts within the 300 s tolerance", () => {
  verifySignature({ header: HEADER, rawBody: BODY, secrets: [SECRET], now: T + 300 });
});

test("rejects a tampered body", () => fails({ rawBody: '{"id":"evt_2"}' }, "signature_mismatch"));

test("rejects re-serialized JSON (whitespace changes the bytes)", () => fails({ rawBody: '{"id": "evt_1"}' }, "signature_mismatch"));

test("accepts any matching v1 and any of several secrets (rotation)", () => {
  verifySignature({ header: `t=${T},v1=${"0".repeat(64)},v1=${V1}`, rawBody: BODY, secrets: ["whsec_new", SECRET], now: T });
});

test("rejects missing and malformed headers", () => {
  fails({ header: undefined }, "missing_signature");
  fails({ header: `v1=${V1}` }, "malformed_signature");
  fails({ header: `t=${T}` }, "malformed_signature");
  fails({ header: `t=${T},t=${T},v1=${V1}` }, "malformed_signature");
  fails({ header: `t=abc,v1=${V1}` }, "malformed_signature");
  fails({ header: `t=${T},v1=nothex` }, "signature_mismatch");
});
