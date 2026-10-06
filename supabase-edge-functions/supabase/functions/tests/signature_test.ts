import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { signPayload, verifySignature, WebhookSignatureError } from "../_shared/signature.ts";

// Test vector of the Limenia webhook documentation.
const SECRET = "whsec_test";
const T = 1800000000;
const BODY = new TextEncoder().encode('{"id":"evt_1"}');
const V1 = "45705be2a45ab5acdd1395cc695e9e7073125385ec24194921c401dff44176f8";
const HEADER = `t=${T},v1=${V1}`;

async function fails(args: Partial<Parameters<typeof verifySignature>[0]>, code: string) {
  const err = await assertRejects(
    () => verifySignature({ header: HEADER, rawBody: BODY, secrets: [SECRET], now: T, ...args }),
    WebhookSignatureError,
  );
  assertEquals(err.code, code);
}

Deno.test("accepts the test vector", async () => {
  await verifySignature({ header: HEADER, rawBody: BODY, secrets: [SECRET], now: T });
  assertEquals(await signPayload(BODY, SECRET, T), HEADER);
});

Deno.test("rejects a wrong secret", () => fails({ secrets: ["whsec_wrong"] }, "signature_mismatch"));

Deno.test("rejects an old timestamp", () => fails({ now: T + 301 }, "timestamp_out_of_range"));

Deno.test("rejects a timestamp too far in the future", () => fails({ now: T - 301 }, "timestamp_out_of_range"));

Deno.test("accepts within the 300 s tolerance", async () => {
  await verifySignature({ header: HEADER, rawBody: BODY, secrets: [SECRET], now: T + 300 });
});

Deno.test("rejects a tampered body", () => fails({ rawBody: new TextEncoder().encode('{"id":"evt_2"}') }, "signature_mismatch"));

Deno.test("accepts any matching v1 and any of several secrets (rotation)", async () => {
  await verifySignature({ header: `t=${T},v1=${"0".repeat(64)},v1=${V1}`, rawBody: BODY, secrets: ["whsec_new", SECRET], now: T });
});

Deno.test("rejects missing and malformed headers", async () => {
  await fails({ header: null }, "missing_signature");
  await fails({ header: `v1=${V1}` }, "malformed_signature");
  await fails({ header: `t=${T}` }, "malformed_signature");
  await fails({ header: `t=${T},t=${T},v1=${V1}` }, "malformed_signature");
  await fails({ header: `t=${T},v1=nothex` }, "signature_mismatch");
});
