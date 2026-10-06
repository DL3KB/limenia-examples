// Cloud Functions for Firebase (2nd gen) between your app and Limenia.
//
// The login is Firebase Authentication: onCall functions get the signed-in user
// in request.auth, and the Firebase UID is the externalUserId at Limenia.

import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { defineSecret, defineString } from "firebase-functions/params";
import { setGlobalOptions } from "firebase-functions/v2";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { actions } from "./actions.js";
import { callLimenia, idempotencyKey } from "./callable.js";
import { issueDeviceTicket, redeemDeviceTicket } from "./device-ticket.js";
import { handleEvent } from "./events.js";
import { LimeniaClient, LimeniaUnavailableError } from "./limenia.js";
import { verifySignature, WebhookSignatureError } from "./signature.js";

initializeApp();
// Choose the region of your project.
setGlobalOptions({ region: "europe-west3", maxInstances: 10 });

const LIMENIA_BASE_URL = defineString("LIMENIA_BASE_URL", { default: "https://app.limenia.eu" });
const LIMENIA_API_KEY = defineSecret("LIMENIA_API_KEY");
const LIMENIA_WEBHOOK_SECRET = defineSecret("LIMENIA_WEBHOOK_SECRET");
const DEVICE_CHECK_SECRET = defineSecret("DEVICE_CHECK_SECRET");

const limenia = () => new LimeniaClient({ baseUrl: LIMENIA_BASE_URL.value(), apiKey: LIMENIA_API_KEY.value() });

function requireUid(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  return request.auth.uid;
}

// ---- Report content or a user ------------------------------------------------
// data: { reasonCategory, reasonText?, subject?, content?, externalReportId?, idempotencyKey }
// Up to 5 attempts with 1, 2, 4, 8 s pause: allow more than the default 60 s.
export const submitReport = onCall({ secrets: [LIMENIA_API_KEY], timeoutSeconds: 120 }, async (request) => {
  const uid = requireUid(request);
  const d = request.data ?? {};
  const report = {
    source: "user",
    reasonCategory: d.reasonCategory,
    reasonText: d.reasonText,
    reporter: { externalUserId: uid }, // from the login, never from the app
    // The reported user (for content: its author). Better: read the content and its
    // author from Firestore by ID instead of trusting what the app sends.
    subject: d.subject,
    content: d.content,
    externalReportId: d.externalReportId,
  };
  const key = idempotencyKey("report", d.idempotencyKey);
  return callLimenia(() => limenia().request("POST", "/v1/reports", { body: report, idempotencyKey: key }), { idempotencyKey: key });
});

// ---- Own moderation status ----------------------------------------------------
export const getMyModerationStatus = onCall({ secrets: [LIMENIA_API_KEY] }, async (request) => {
  const uid = requireUid(request);
  return callLimenia(() => limenia().request("GET", `/v1/subjects/${encodeURIComponent(uid)}/status`));
});

// ---- Device check ---------------------------------------------------------------
// Step 1: the app gets { requestHash, ticket } and requests a token with requestHash (limenia_device).
export const requestDeviceHash = onCall({ secrets: [DEVICE_CHECK_SECRET] }, async (request) => {
  return issueDeviceTicket(requireUid(request), DEVICE_CHECK_SECRET.value());
});

// Step 2: data { platform, token, ticket, environment?, event? }
export const checkDevice = onCall({ secrets: [LIMENIA_API_KEY, DEVICE_CHECK_SECRET] }, async (request) => {
  const uid = requireUid(request);
  const { platform, token, ticket, environment, event } = request.data ?? {};
  const check = { externalUserId: uid, platform, token, event };
  if (platform === "android") {
    const requestHash = redeemDeviceTicket(ticket, uid, DEVICE_CHECK_SECRET.value());
    if (!requestHash) throw new HttpsError("invalid-argument", "Request a hash first.", { code: "request_hash_missing" });
    check.requestHash = requestHash;
  }
  if (platform === "ios" && environment) check.environment = environment;

  // Sent once: the token is single-use. Network errors, 429 and 5xx count as unevaluated (fail open).
  try {
    const result = await limenia().request("POST", "/v1/devices/check", { body: check, retry: false });
    if (result.status === 429 || result.status >= 500) return { status: "unevaluated", deviceFlag: "unknown" };
    // Decide here what follows (e.g. hold a registration on deviceFlag "banned"); this returns Limenia's answer.
    return await callLimenia(async () => result);
  } catch (err) {
    if (err instanceof LimeniaUnavailableError) return { status: "unevaluated", deviceFlag: "unknown" };
    throw err;
  }
});

// ---- Webhook receiver -------------------------------------------------------------
// Public (invoker: "public"): Limenia has no Google credentials, the signature is the
// authentication. Limenia waits 10 s for the answer.
export const limeniaWebhook = onRequest(
  { secrets: [LIMENIA_WEBHOOK_SECRET], invoker: "public", timeoutSeconds: 10, cors: false },
  async (req, res) => {
    if (req.method !== "POST") return void res.status(405).end();
    try {
      // req.rawBody: the exact bytes Limenia signed. Never use JSON.stringify(req.body).
      verifySignature({ header: req.get("Limenia-Signature"), rawBody: req.rawBody, secrets: [LIMENIA_WEBHOOK_SECRET.value()] });
    } catch (err) {
      if (err instanceof WebhookSignatureError) return void res.status(401).json({ code: err.code });
      throw err;
    }
    let event;
    try {
      event = JSON.parse(req.rawBody.toString("utf8"));
    } catch {
      return void res.status(400).json({ code: "invalid_body" });
    }
    try {
      const result = await withDeadline(handleEvent(event, { store: firestoreEventStore(), actions }), 8_000);
      logger.info("webhook", { eventId: event.id, type: event.type, result });
      res.status(204).end();
    } catch (err) {
      logger.error("webhook failed", { eventId: event.id, error: String(err?.message ?? err) });
      res.status(503).end(); // Limenia retries
    }
  },
);

// Processed event IDs in Firestore. Set a TTL policy on expireAt to clean up.
function firestoreEventStore() {
  const doc = (id) => getFirestore().collection("limeniaWebhookEvents").doc(String(id).replaceAll("/", "_"));
  return {
    async isProcessed(id) {
      return (await doc(id).get()).exists;
    },
    async markProcessed(id) {
      const expireAt = Timestamp.fromMillis(Date.now() + 30 * 24 * 3600 * 1000);
      await doc(id).set({ processedAt: FieldValue.serverTimestamp(), expireAt });
    },
  };
}

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("deadline exceeded")), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
