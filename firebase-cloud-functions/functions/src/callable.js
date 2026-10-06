// Helpers for the onCall functions: idempotency keys and error mapping.

import { randomUUID } from "node:crypto";
import { HttpsError } from "firebase-functions/v2/https";
import { LimeniaUnavailableError } from "./limenia.js";

/**
 * The app should create one key per report and send it again on every retry.
 * Without one, a key is made here; it then only covers our own retries.
 */
export function idempotencyKey(kind, fromApp) {
  if (typeof fromApp === "string" && fromApp.length > 0 && fromApp.length <= 200) return fromApp;
  return `${kind}-${randomUUID()}`;
}

const CODES = {
  400: "invalid-argument",
  402: "failed-precondition",
  403: "permission-denied",
  404: "not-found",
  409: "failed-precondition",
  429: "resource-exhausted",
};

/**
 * Returns Limenia's body on success. Otherwise throws an HttpsError whose details
 * carry Limenia's status, problem body (code, errors, suspendedUntil ...), Retry-After
 * and the Idempotency-Key used, so the app can retry with the same key.
 */
export async function callLimenia(call, { idempotencyKey } = {}) {
  let result;
  try {
    result = await call();
  } catch (err) {
    if (err instanceof LimeniaUnavailableError) {
      throw new HttpsError("unavailable", "Limenia could not be reached. Try again later.", { status: 502, code: "limenia_unreachable", idempotencyKey });
    }
    throw err;
  }
  if (result.status < 400) return result.body;
  if (result.status === 401) {
    // Limenia rejected OUR API key: a server problem, not a signed-out user.
    throw new HttpsError("internal", "The moderation service rejected the backend's credentials.");
  }
  const code = CODES[result.status] ?? (result.status >= 500 ? "unavailable" : "unknown");
  throw new HttpsError(code, result.body?.detail ?? result.body?.title ?? "Request failed", {
    status: result.status,
    problem: result.body,
    retryAfter: result.retryAfter,
    idempotencyKey,
  });
}
