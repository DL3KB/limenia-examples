// PLACEHOLDERS: what your app does when Limenia reports a decision.
//
// Replace the log lines with your own code (e.g. update DynamoDB, call Cognito's
// AdminDisableUser on a ban). Make them idempotent: set a state instead of
// toggling it. Log IDs only, never texts, names or e-mail addresses.

const log = (msg, ids) => console.log(JSON.stringify({ msg, ...ids }));

export const actions = {
  async removeContent(contentId) {
    log("remove content", { contentId });
  },
  async restrictContent(contentId) {
    log("restrict content", { contentId });
  },
  async restoreContent(contentId) {
    log("restore content", { contentId });
  },
  async publishSubmission(contentId, { restricted = false } = {}) {
    log("publish submitted content", { contentId, restricted });
  },
  async rejectSubmission(contentId) {
    log("do not publish submitted content", { contentId });
  },
  async warnUser(userId) {
    log("warn user", { userId });
  },
  async suspendUser(userId, until) {
    // Lift it at `until` yourself; subject.status_changed can come up to an hour later.
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
  async notifyAffectedUser(userId, decision) {
    // Show decision.statementOfReasons.text as plain text.
    log("send statement of reasons", { userId, decisionId: decision.id });
  },
  async notifyReporters(reports) {
    log("notify reporters", { decisionId: reports.decisionId, count: reports.items?.length ?? 0 });
  },
  async notifyAppellant(appeal) {
    log("send answer to complaint", { appealId: appeal.id, outcome: appeal.outcome });
  },
};
