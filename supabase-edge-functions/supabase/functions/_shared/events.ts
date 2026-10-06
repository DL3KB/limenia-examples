// What to do with each verified webhook event.
//
// Events can arrive more than once (deduplicated here by event ID) and out of
// order. Make the actions idempotent. For ordering by decidedAt per user and
// content, see the node-express example.

export interface WebhookDecision {
  id: string;
  action: string;
  suspendUntil?: string;
  content?: { externalContentId: string };
  subject?: { externalUserId: string };
  statementOfReasons?: { text: string };
  decidedAt: string;
  appealId?: string;
  reviewId?: string;
  restoreScope?: "content" | "account";
}

export interface WebhookEvent {
  id: string;
  type: string;
  createdAt?: string;
  decision?: WebhookDecision;
  subject?: { externalUserId: string; status: string; suspendedUntil?: string };
  appeal?: { id: string; externalAppealId?: string; outcome?: string; statementText?: string };
  reports?: { decisionId: string; items?: { reportId: string; externalReportId?: string }[] };
  review?: { id: string; externalReviewId?: string; outcome: string; content?: { externalContentId: string } };
}

export interface Actions {
  removeContent(contentId: string): Promise<void>;
  restrictContent(contentId: string): Promise<void>;
  restoreContent(contentId: string): Promise<void>;
  publishSubmission(contentId: string, options?: { restricted?: boolean }): Promise<void>;
  rejectSubmission(contentId: string): Promise<void>;
  warnUser(userId: string): Promise<void>;
  suspendUser(userId: string, until: string | undefined): Promise<void>;
  banUser(userId: string): Promise<void>;
  restoreAccount(userId: string): Promise<void>;
  setAccountStatus(userId: string, status: string, suspendedUntil?: string): Promise<void>;
  notifyAffectedUser(userId: string, decision: WebhookDecision): Promise<void>;
  notifyReporters(reports: NonNullable<WebhookEvent["reports"]>): Promise<void>;
  notifyAppellant(appeal: NonNullable<WebhookEvent["appeal"]>): Promise<void>;
}

export interface EventStore {
  isProcessed(eventId: string): Promise<boolean>;
  markProcessed(eventId: string): Promise<void>;
}

export async function handleEvent(
  event: WebhookEvent,
  deps: { store: EventStore; actions: Actions },
): Promise<"processed" | "duplicate" | "ignored"> {
  const { store, actions } = deps;
  if (await store.isProcessed(event.id)) return "duplicate";
  let result: "processed" | "ignored" = "processed";
  switch (event.type) {
    case "decision.created":
      if (event.decision) await applyDecision(event.decision, actions);
      break;
    case "subject.status_changed":
      if (event.subject) await actions.setAccountStatus(event.subject.externalUserId, event.subject.status, event.subject.suspendedUntil);
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
      if (contentId && event.review?.outcome === "approved") await actions.publishSubmission(contentId);
      if (contentId && event.review?.outcome === "restricted") await actions.publishSubmission(contentId, { restricted: true });
      if (contentId && event.review?.outcome === "rejected") await actions.rejectSubmission(contentId);
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

export async function applyDecision(d: WebhookDecision, actions: Actions): Promise<void> {
  const userId = d.subject?.externalUserId;
  const contentId = d.content?.externalContentId;
  const restoreScope = d.restoreScope ?? (contentId ? "content" : "account");
  // Decisions on review requests (reviewId) never change the account.
  const accountUser = !d.reviewId && (ACCOUNT_ACTIONS.has(d.action) || (d.action === "restore" && restoreScope === "account"))
    ? userId
    : undefined;

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
      if (accountUser) await actions.warnUser(accountUser);
      break;
    case "suspend_user":
      if (accountUser) await actions.suspendUser(accountUser, d.suspendUntil);
      break;
    case "ban_user":
      if (accountUser) await actions.banUser(accountUser);
      break;
    case "restore":
      if (accountUser) await actions.restoreAccount(accountUser);
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
