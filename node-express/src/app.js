import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import express from "express";
import { requireUser } from "./auth.js";
import { DeviceHashStore } from "./device.js";
import { createEventHandler, MemoryEventStore } from "./events.js";
import { LimeniaUnavailableError } from "./limenia.js";
import { verifySignature, WebhookSignatureError } from "./signature.js";

const WEBHOOK_DEADLINE_MS = 8_000; // Limenia waits 10 s for the answer

/**
 * @param {object} deps
 * @param {import("./limenia.js").LimeniaClient} deps.limenia
 * @param {string[]} deps.webhookSecrets
 * @param {typeof import("./actions.js").actions} deps.actions
 * @param {MemoryEventStore} [deps.eventStore]
 */
export function createApp({ limenia, webhookSecrets, actions, eventStore = new MemoryEventStore() }) {
  const app = express();
  const handleEvent = createEventHandler({ actions, store: eventStore });
  const deviceHashes = new DeviceHashStore();
  // Who created which complaint and review request. REPLACE WITH YOUR DATABASE.
  const appealOwners = new Map();
  const reviewOwners = new Map();

  // ---- Webhook receiver --------------------------------------------------
  // Registered before express.json(): the signature covers the RAW body.
  app.post("/limenia/webhook", express.raw({ type: () => true, limit: "1mb" }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      verifySignature({ header: req.get("Limenia-Signature"), rawBody, secrets: webhookSecrets });
    } catch (err) {
      if (err instanceof WebhookSignatureError) return res.status(401).json({ code: err.code });
      throw err;
    }
    let event;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).json({ code: "invalid_body" });
    }
    try {
      const result = await withDeadline(handleEvent(event), WEBHOOK_DEADLINE_MS);
      console.log(JSON.stringify({ msg: "webhook", eventId: event.id, type: event.type, result }));
      res.sendStatus(204);
    } catch (err) {
      // Any non-2xx answer makes Limenia retry later (first retry after 1 minute).
      console.error(JSON.stringify({ msg: "webhook failed", eventId: event.id, error: String(err?.message ?? err) }));
      res.sendStatus(503);
    }
  });

  // ---- Endpoints for your app ----------------------------------------------
  app.use(express.json({ limit: "1mb" }));

  // Report content or a user. The reporter is the signed-in user.
  app.post("/reports", requireUser, async (req, res) => {
    const b = req.body ?? {};
    const report = {
      source: "user",
      reasonCategory: b.reasonCategory,
      reasonText: b.reasonText,
      reporter: { externalUserId: req.user.id }, // from the login, never from the app
      // The reported user (for content: its author). Better: load the content and its
      // author from your database by ID instead of trusting what the app sends.
      subject: b.subject,
      content: b.content,
      externalReportId: b.externalReportId,
    };
    await forward(res, () =>
      limenia.request("POST", "/v1/reports", { body: report, idempotencyKey: idempotencyKey(req, res, "report") }),
    );
  });

  // Moderation status of the signed-in user (and only of them).
  app.get("/me/moderation-status", requireUser, async (req, res) => {
    await forward(res, () => limenia.request("GET", `/v1/subjects/${encodeURIComponent(req.user.id)}/status`));
  });

  // Complaint against a decision, by the affected user ("subject") or a reporter ("reporter").
  app.post("/appeals", requireUser, async (req, res) => {
    const b = req.body ?? {};
    const appeal = {
      decisionId: b.decisionId,
      appellant: { type: b.appellantType, externalUserId: req.user.id },
      text: b.text,
      externalAppealId: b.externalAppealId,
    };
    await forward(
      res,
      () => limenia.request("POST", "/v1/appeals", { body: appeal, idempotencyKey: idempotencyKey(req, res, "appeal") }),
      (created) => appealOwners.set(created.appealId, req.user.id),
    );
  });

  app.get("/appeals/:appealId", requireUser, async (req, res) => {
    // Only the person who complained may see the status.
    if (appealOwners.get(req.params.appealId) !== req.user.id) return problem(res, 404, "not_found", "Unknown complaint.");
    await forward(res, () => limenia.request("GET", `/v1/appeals/${encodeURIComponent(req.params.appealId)}`));
  });

  // Submit content for review before publishing it. The author is the signed-in user.
  app.post("/reviews", requireUser, async (req, res) => {
    const b = req.body ?? {};
    const review = {
      type: b.type,
      externalReviewId: b.externalReviewId,
      subject: { externalUserId: req.user.id, displayName: b.displayName },
      content: b.content,
    };
    await forward(
      res,
      () => limenia.request("POST", "/v1/reviews", { body: review, idempotencyKey: idempotencyKey(req, res, "review") }),
      (created) => reviewOwners.set(created.reviewId, req.user.id),
    );
  });

  app.get("/reviews/:reviewId", requireUser, async (req, res) => {
    if (reviewOwners.get(req.params.reviewId) !== req.user.id) return problem(res, 404, "not_found", "Unknown review request.");
    await forward(res, () => limenia.request("GET", `/v1/reviews/${encodeURIComponent(req.params.reviewId)}`));
  });

  // Device check, step 1: a fresh request hash for the signed-in user (Android).
  app.post("/devices/request-hash", requireUser, (req, res) => {
    res.json({ requestHash: deviceHashes.issue(req.user.id) });
  });

  // Device check, step 2: the app sends { platform, token, event?, environment? }
  // with the token it got from limenia_device. Call it at registration and at every
  // login, also for a banned account before you reject the login.
  app.post("/devices/check", requireUser, async (req, res) => {
    const { platform, token, environment, event } = req.body ?? {};
    const check = { externalUserId: req.user.id, platform, token, event };
    const pendingHash = deviceHashes.take(req.user.id);
    if (platform === "android") {
      if (!pendingHash) return problem(res, 400, "request_hash_missing", "Request a hash first.");
      check.requestHash = pendingHash;
    }
    if (platform === "ios" && environment) check.environment = environment;

    // No retry: a device token is single-use. No Idempotency-Key either.
    let result;
    try {
      result = await limenia.request("POST", "/v1/devices/check", { body: check, retry: false });
    } catch (err) {
      if (!(err instanceof LimeniaUnavailableError)) throw err;
      result = null;
    }
    if (!result || result.status === 429 || result.status >= 500) {
      // Fail open. Never reject a login because the check could not run.
      return res.json({ status: "unevaluated", deviceFlag: "unknown" });
    }
    // Decide here what follows (e.g. hold a registration for review on deviceFlag "banned").
    // This example simply returns Limenia's answer.
    await forward(res, async () => result);
  });

  return app;
}

/**
 * The app should create one key per report and send it again on every retry.
 * Without one, a key is made here; it then only covers our own retries to Limenia.
 * The key goes back to the app in the response header Idempotency-Key.
 */
function idempotencyKey(req, res, kind) {
  const fromApp = req.get("Idempotency-Key");
  const key = fromApp && fromApp.length <= 200 ? fromApp : `${kind}-${randomUUID()}`;
  res.set("Idempotency-Key", key);
  return key;
}

/** Passes Limenia's status, problem body and Retry-After on to the app. */
async function forward(res, call, onSuccess) {
  let result;
  try {
    result = await call();
  } catch (err) {
    if (err instanceof LimeniaUnavailableError) return problem(res, 502, "limenia_unreachable", "Limenia could not be reached.");
    throw err;
  }
  if (result.retryAfter) res.set("Retry-After", result.retryAfter);
  // Note: a 401 from Limenia means the backend's API key is wrong, not that the app user
  // is signed out. Do not sign the user out in the app because of it.
  if (result.status >= 400) {
    const body = result.body ?? { type: "about:blank", title: "Upstream Error", status: result.status, code: "upstream_error" };
    return res.status(result.status).type("application/problem+json").send(JSON.stringify(body));
  }
  if (onSuccess && result.body) await onSuccess(result.body);
  res.status(result.status).json(result.body);
}

function problem(res, status, code, detail) {
  res.status(status).type("application/problem+json").send(JSON.stringify({ type: "about:blank", title: STATUS_CODES[status], status, code, detail }));
}

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("deadline exceeded")), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
