// Request hash for the device check, without server-side state.
//
// requestHash = base64url(SHA-256("limenia:" + externalUserId + ":" + nonce)), without padding.
//
// Serverless functions keep no memory between calls, so instead of storing the
// nonce the backend hands the app a signed ticket: nonce, expiry and an HMAC
// over user, nonce and expiry. The app requests the device token with the
// requestHash (plugin limenia_device) and sends the token back with the ticket.
// The backend checks the ticket against the signed-in user and recomputes the
// hash, so a ticket of one user is useless for another.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TTL_SECONDS = 10 * 60; // Limenia accepts Android tokens up to 15 minutes old

export function deviceRequestHash(externalUserId, nonce) {
  return createHash("sha256").update(`limenia:${externalUserId}:${nonce}`).digest("base64url");
}

const mac = (secret, userId, nonce, exp) => createHmac("sha256", secret).update(`${userId}\n${nonce}\n${exp}`).digest();

export function issueDeviceTicket(userId, secret, now = Date.now() / 1000) {
  const nonce = randomBytes(16).toString("base64url");
  const exp = Math.floor(now) + TTL_SECONDS;
  const ticket = `${nonce}.${exp}.${mac(secret, userId, nonce, exp).toString("base64url")}`;
  return { ticket, requestHash: deviceRequestHash(userId, nonce) };
}

/** The requestHash of a valid ticket of this user, or null. */
export function redeemDeviceTicket(ticket, userId, secret, now = Date.now() / 1000) {
  const [nonce, exp, sig] = String(ticket ?? "").split(".");
  if (!nonce || !/^\d+$/.test(exp ?? "") || !sig || Number(exp) < now) return null;
  const expected = mac(secret, userId, nonce, exp);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return deviceRequestHash(userId, nonce);
}
