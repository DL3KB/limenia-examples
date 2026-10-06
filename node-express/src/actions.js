// PLACEHOLDERS: what your app does when Limenia reports a decision.
//
// Replace each function with your own code. Make them idempotent: set a state
// ("hidden", "banned until X") instead of toggling it, because an event can
// arrive more than once and out of order.
//
// Log IDs only, never texts, names or e-mail addresses.

const log = (msg, ids) => console.log(JSON.stringify({ msg, ...ids }));

export const actions = {
  // Content
  async removeContent(contentId) {
    log("remove content", { contentId });
  },
  async restrictContent(contentId) {
    log("restrict content (e.g. hide from feeds and search)", { contentId });
  },
  async restoreContent(contentId) {
    log("restore content", { contentId });
  },

  // Content submitted for review (pre-moderation)
  async publishSubmission(contentId, { restricted = false } = {}) {
    log("publish submitted content", { contentId, restricted });
  },
  async rejectSubmission(contentId) {
    log("do not publish submitted content", { contentId });
  },

  // Account
  async warnUser(userId) {
    log("warn user", { userId });
  },
  async suspendUser(userId, until) {
    // Lift the suspension yourself at `until`: subject.status_changed can come up to an hour later.
    log("suspend user", { userId, until });
  },
  async banUser(userId) {
    log("ban user", { userId });
  },
  async restoreAccount(userId) {
    log("unblock account", { userId });
  },
  async setAccountStatus(userId, status, suspendedUntil) {
    log("set account status", { userId, status, suspendedUntil });
  },

  // Notifications (texts are ready-made by Limenia; show them as plain text, not HTML)
  async notifyAffectedUser(userId, decision) {
    // Show decision.statementOfReasons.text to the user, e.g. in the app or by e-mail if the account is blocked.
    log("send statement of reasons", { userId, decisionId: decision.id });
  },
  async notifyReporters(reports) {
    // Map reports.items[].externalReportId (or reportId) to your reports and users,
    // tell them the outcome and that they can complain until reports.appealDeadline.
    log("notify reporters", { decisionId: reports.decisionId, count: reports.items?.length ?? 0 });
  },
  async notifyAppellant(appeal) {
    // Find the person by appeal.id or appeal.externalAppealId and show appeal.statementText.
    log("send answer to complaint", { appealId: appeal.id, outcome: appeal.outcome });
  },
};
