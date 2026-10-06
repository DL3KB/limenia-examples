// Verification of the header Limenia-Signature with Web Crypto:
// t=<unix seconds>,v1=<hex>[,v1=<hex>...]
// v1 = hex(HMAC-SHA256(secret, t + "." + rawBody)), computed over the RAW body.

export const TOLERANCE_SECONDS = 300;

export type SignatureErrorCode =
  | "missing_signature"
  | "malformed_signature"
  | "timestamp_out_of_range"
  | "signature_mismatch";

export class WebhookSignatureError extends Error {
  constructor(readonly code: SignatureErrorCode) {
    super(`invalid webhook signature: ${code}`);
  }
}

const encoder = new TextEncoder();

async function hmacSha256(secret: string, timestamp: string, rawBody: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = encoder.encode(`${timestamp}.`);
  const data = new Uint8Array(prefix.length + rawBody.length);
  data.set(prefix);
  data.set(rawBody, prefix.length);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

function fromHex(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Compares in constant time (for equal lengths). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Throws WebhookSignatureError unless one v1 value matches one of the secrets.
 * rawBody: the body exactly as received (await req.arrayBuffer()), never re-serialized JSON.
 * secrets: the current secret, plus the previous one during a rotation.
 */
export async function verifySignature(args: {
  header: string | null | undefined;
  rawBody: Uint8Array;
  secrets: string[];
  now?: number;
}): Promise<void> {
  const { header, rawBody, secrets, now = Date.now() / 1000 } = args;
  if (!header) throw new WebhookSignatureError("missing_signature");

  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 1) throw new WebhookSignatureError("malformed_signature");
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      if (timestamp !== undefined) throw new WebhookSignatureError("malformed_signature");
      timestamp = value;
    } else if (key === "v1") {
      signatures.push(value);
    } // other keys (future schemes) are ignored
  }
  if (timestamp === undefined || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0) {
    throw new WebhookSignatureError("malformed_signature");
  }
  if (Math.abs(now - Number(timestamp)) > TOLERANCE_SECONDS) {
    throw new WebhookSignatureError("timestamp_out_of_range");
  }

  for (const secret of secrets) {
    const expected = await hmacSha256(secret, timestamp, rawBody);
    for (const signature of signatures) {
      const given = fromHex(signature);
      if (given && timingSafeEqual(expected, given)) return;
    }
  }
  throw new WebhookSignatureError("signature_mismatch");
}

/** Builds a valid header, for tests and local experiments. */
export async function signPayload(rawBody: string | Uint8Array, secret: string, timestamp: number): Promise<string> {
  const body = typeof rawBody === "string" ? encoder.encode(rawBody) : rawBody;
  const mac = await hmacSha256(secret, String(timestamp), body);
  return `t=${timestamp},v1=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
