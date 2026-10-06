// Verification of the header Limenia-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>...]
// v1 = hex(HMAC-SHA256(secret, t + "." + rawBody)), computed over the RAW body.

import { createHmac, timingSafeEqual } from "node:crypto";

export const TOLERANCE_SECONDS = 300;

export class WebhookSignatureError extends Error {
  /** @param {"missing_signature"|"malformed_signature"|"timestamp_out_of_range"|"signature_mismatch"} code */
  constructor(code) {
    super(`invalid webhook signature: ${code}`);
    this.code = code;
  }
}

/**
 * Throws WebhookSignatureError unless one v1 value matches one of the secrets.
 * @param {object} args
 * @param {string|undefined|null} args.header value of Limenia-Signature
 * @param {Buffer|string} args.rawBody the body exactly as received, never re-serialized JSON
 * @param {string[]} args.secrets current secret, plus the previous one during a rotation
 * @param {number} [args.now] current time in Unix seconds
 */
export function verifySignature({ header, rawBody, secrets, now = Date.now() / 1000 }) {
  if (!header) throw new WebhookSignatureError("missing_signature");

  let timestamp;
  const signatures = [];
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

  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest();
    for (const signature of signatures) {
      if (!/^[0-9a-fA-F]{64}$/.test(signature)) continue;
      if (timingSafeEqual(expected, Buffer.from(signature, "hex"))) return;
    }
  }
  throw new WebhookSignatureError("signature_mismatch");
}

/** Builds a valid header, for tests and local experiments. */
export function signPayload(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}
