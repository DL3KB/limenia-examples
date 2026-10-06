// Request hash for the device check, without server-side state.
//
// requestHash = base64url(SHA-256("limenia:" + externalUserId + ":" + nonce)), without padding.
//
// Edge Functions keep no memory between calls, so instead of storing the nonce the
// function hands the app a signed ticket: nonce, expiry and an HMAC over user,
// nonce and expiry. The app requests the device token with the requestHash
// (plugin limenia_device) and sends the token back with the ticket. The function
// checks the ticket against the signed-in user and recomputes the hash.

const TTL_SECONDS = 10 * 60; // Limenia accepts Android tokens up to 15 minutes old
const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function deviceRequestHash(externalUserId: string, nonce: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`limenia:${externalUserId}:${nonce}`));
  return base64url(new Uint8Array(digest));
}

async function mac(secret: string, userId: string, nonce: string, exp: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${userId}\n${nonce}\n${exp}`)));
}

export async function issueDeviceTicket(userId: string, secret: string, now = Date.now() / 1000) {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const exp = String(Math.floor(now) + TTL_SECONDS);
  const ticket = `${nonce}.${exp}.${base64url(await mac(secret, userId, nonce, exp))}`;
  return { ticket, requestHash: await deviceRequestHash(userId, nonce) };
}

/** The requestHash of a valid ticket of this user, or null. */
export async function redeemDeviceTicket(ticket: unknown, userId: string, secret: string, now = Date.now() / 1000): Promise<string | null> {
  const [nonce, exp, sig] = String(ticket ?? "").split(".");
  if (!nonce || !/^\d+$/.test(exp ?? "") || !sig || Number(exp) < now) return null;
  const expected = base64url(await mac(secret, userId, nonce, exp));
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? await deviceRequestHash(userId, nonce) : null;
}
