// What to do with each verified webhook event.
//
// Events can arrive more than once (deduplicated here by event ID) and out of
// order. Make the actions idempotent. For ordering by decidedAt per user and
// content, see the node-express example.

export async function handleEvent(event, { store, actions }) {
  if (await store.isProcessed(event.id)) return "duplicate";
  let result = "processed";
  switch (event.type) {
    case "decision.created":
      if (event.decision) await applyDecision(event.decision, actions);
      break;
    case "subject.status_changed":
      if (event.subject) {
        const { externalUserId, status, suspendedUntil } = event.subject;
        await actions.setAccountStatus(externalUserId, status, suspendedUntil);
      }
      break;
    case "appeal.resolved":
      // outcome "changed": the new decision arrives as its own decision.created; apply it there.
      if (event.appeal) await actions.notifyAppellant(event.appeal);
      break;
    case "reports.resolved":
      if (event.reports) await actions.notifyReporters(event.reports);
      break;
    case "review.decided": {
      const contentId = event.review?.content?.externalContentId;
      if (contentId && event.review.outcome === "approved") await actions.publishSubmission(contentId);
      if (contentId && event.review.outcome === "restricted") await actions.publishSubmission(contentId, { restricted: true });
      if (contentId && event.review.outcome === "rejected") await actions.rejectSubmission(contentId);
      break;
    }
    case "test.ping":
      break;
    default:
      result = "ignored"; // unknown types are acknowledged with 2xx
  }
  await store.markProcessed(event.id);
  return result;
}

const ACCOUNT_ACTIONS = new Set(["warn_user", "suspend_user", "ban_user"]);

export async function applyDecision(d, actions) {
  const userId = d.subject?.externalUserId;
  const contentId = d.content?.externalContentId;
  const restoreScope = d.restoreScope ?? (contentId ? "content" : "account");
  // Decisions on review requests (reviewId) never change the account.
  const touchesAccount =
    !d.reviewId && !!userId && (ACCOUNT_ACTIONS.has(d.action) || (d.action === "restore" && restoreScope === "account"));

  switch (d.action) {
    case "dismiss":
      return; // nothing changes; reporters learn the outcome via reports.resolved
    case "remove_content":
      if (contentId) await actions.removeContent(contentId);
      break;
    case "restrict_content":
      if (contentId && d.reviewId) await actions.publishSubmission(contentId, { restricted: true });
      else if (contentId) await actions.restrictContent(contentId);
      break;
    case "reject_submission":
      if (contentId) await actions.rejectSubmission(contentId);
      break;
    case "warn_user":
      if (touchesAccount) await actions.warnUser(userId);
      break;
    case "suspend_user":
      if (touchesAccount) await actions.suspendUser(userId, d.suspendUntil);
      break;
    case "ban_user":
      if (touchesAccount) await actions.banUser(userId);
      break;
    case "restore":
      if (touchesAccount) await actions.restoreAccount(userId);
      else if (contentId && d.reviewId) await actions.publishSubmission(contentId);
      else if (contentId) await actions.restoreContent(contentId);
      break;
    default:
      // Not supported by your app: acknowledge anyway, otherwise Limenia retries for about 20 hours.
      console.warn(JSON.stringify({ msg: "unsupported action", decisionId: d.id, action: d.action }));
      return;
  }
  if (userId) await actions.notifyAffectedUser(userId, d);
}
