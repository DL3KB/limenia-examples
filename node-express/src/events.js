// What to do with each verified webhook event.

/**
 * In-memory store, fine for one process and for tests.
 * REPLACE WITH YOUR DATABASE (e.g. a table with the event ID as primary key)
 * when you run more than one instance or need it to survive a restart.
 */
export class MemoryEventStore {
  #processed = new Set();
  #lastApplied = new Map();

  async isProcessed(eventId) {
    return this.#processed.has(eventId);
  }
  async markProcessed(eventId) {
    this.#processed.add(eventId);
  }
  // Events can arrive out of order. Remember per user and per content when the
  // last change happened and skip older ones, so a late suspend_user does not
  // override a later restore. Equal timestamps are not skipped.
  async isOutdated(key, at) {
    const last = this.#lastApplied.get(key);
    return last !== undefined && sortable(at) < last;
  }
  async recordApplied(key, at) {
    const value = sortable(at);
    const last = this.#lastApplied.get(key);
    if (last === undefined || value > last) this.#lastApplied.set(key, value);
  }
}

/** RFC 3339 UTC timestamps with 0 to 9 fractional digits, made comparable as strings. */
export function sortable(ts) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(ts ?? "");
  if (m) return `${m[1]}.${(m[2] ?? "").padEnd(9, "0")}`;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? "" : sortable(new Date(ms).toISOString());
}

const ACCOUNT_ACTIONS = new Set(["warn_user", "suspend_user", "ban_user"]);

export function createEventHandler({ actions, store }) {
  async function applyDecision(d) {
    const userId = d.subject?.externalUserId;
    const contentId = d.content?.externalContentId;
    const restoreScope = d.restoreScope ?? (contentId ? "content" : "account");
    // Decisions on review requests (reviewId) never change the account.
    const touchesAccount =
      !d.reviewId && (ACCOUNT_ACTIONS.has(d.action) || (d.action === "restore" && restoreScope === "account"));
    const key = touchesAccount ? (userId && `user:${userId}`) : (contentId && `content:${contentId}`);
    if (key && (await store.isOutdated(key, d.decidedAt))) return;

    switch (d.action) {
      case "dismiss":
        break; // nothing changes; reporters learn the outcome via reports.resolved
      case "remove_content":
        if (contentId) await actions.removeContent(contentId);
        break;
      case "restrict_content":
        if (contentId) {
          if (d.reviewId) await actions.publishSubmission(contentId, { restricted: true });
          else await actions.restrictContent(contentId);
        }
        break;
      case "reject_submission":
        if (contentId) await actions.rejectSubmission(contentId);
        break;
      case "warn_user":
        if (touchesAccount && userId) await actions.warnUser(userId);
        break;
      case "suspend_user":
        if (touchesAccount && userId) await actions.suspendUser(userId, d.suspendUntil);
        break;
      case "ban_user":
        if (touchesAccount && userId) await actions.banUser(userId);
        break;
      case "restore":
        if (touchesAccount && userId) await actions.restoreAccount(userId);
        else if (contentId) {
          if (d.reviewId) await actions.publishSubmission(contentId);
          else await actions.restoreContent(contentId);
        }
        break;
      default:
        // An action your app does not support: acknowledge anyway, otherwise Limenia retries for about 20 hours.
        console.warn(JSON.stringify({ msg: "unsupported action", decisionId: d.id, action: d.action }));
        return;
    }
    if (d.action !== "dismiss" && userId) await actions.notifyAffectedUser(userId, d);
    if (key) await store.recordApplied(key, d.decidedAt);
  }

  async function applyStatus(event) {
    const { externalUserId, status, suspendedUntil } = event.subject;
    const key = `user:${externalUserId}`;
    if (await store.isOutdated(key, event.createdAt)) return;
    await actions.setAccountStatus(externalUserId, status, suspendedUntil);
    await store.recordApplied(key, event.createdAt);
  }

  async function applyReview(review) {
    const contentId = review.content?.externalContentId;
    if (!contentId) return;
    // A complaint can change the result later (decision.created with reviewId), so skip a late review.decided.
    const key = `content:${contentId}`;
    if (await store.isOutdated(key, review.decidedAt)) return;
    if (review.outcome === "approved") await actions.publishSubmission(contentId);
    else if (review.outcome === "restricted") await actions.publishSubmission(contentId, { restricted: true });
    else if (review.outcome === "rejected") await actions.rejectSubmission(contentId);
    await store.recordApplied(key, review.decidedAt);
  }

  /** @returns {Promise<"processed"|"duplicate"|"ignored">} */
  return async function handleEvent(event) {
    if (await store.isProcessed(event.id)) return "duplicate";
    let result = "processed";
    switch (event.type) {
      case "decision.created":
        if (event.decision) await applyDecision(event.decision);
        break;
      case "subject.status_changed":
        if (event.subject) await applyStatus(event);
        break;
      case "appeal.resolved":
        // outcome "changed": the new decision arrives as its own decision.created; apply it there.
        if (event.appeal) await actions.notifyAppellant(event.appeal);
        break;
      case "reports.resolved":
        if (event.reports) await actions.notifyReporters(event.reports);
        break;
      case "review.decided":
        if (event.review) await applyReview(event.review);
        break;
      case "test.ping":
        break;
      default:
        result = "ignored"; // unknown types are acknowledged with 2xx
    }
    await store.markProcessed(event.id);
    return result;
  };
}
