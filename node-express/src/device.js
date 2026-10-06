// Request hash for the device check (POST /v1/devices/check).
//
// requestHash = base64url(SHA-256("limenia:" + externalUserId + ":" + nonce)), without padding.
// The backend picks the nonce, computes the hash for the signed-in user and
// keeps it for 10 minutes. The app requests the device token with this hash
// (plugin limenia_device) and sends the token. The backend uses the hash it
// kept for this user, once.

import { createHash, randomBytes } from "node:crypto";

export function deviceRequestHash(externalUserId, nonce) {
  return createHash("sha256").update(`limenia:${externalUserId}:${nonce}`).digest("base64url");
}

const TTL_MS = 10 * 60 * 1000; // Limenia accepts Android tokens up to 15 minutes old

/**
 * User ID -> pending hash, in memory. REPLACE WITH YOUR CACHE (e.g. Redis with
 * expiry) when you run more than one instance.
 */
export class DeviceHashStore {
  #pending = new Map();

  issue(userId, now = Date.now()) {
    const hash = deviceRequestHash(userId, randomBytes(24).toString("hex"));
    this.#pending.set(userId, { hash, expiresAt: now + TTL_MS });
    return hash;
  }

  /** The pending hash of this user, or null. Single use. */
  take(userId, now = Date.now()) {
    const entry = this.#pending.get(userId);
    this.#pending.delete(userId);
    return entry && entry.expiresAt >= now ? entry.hash : null;
  }
}
