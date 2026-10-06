// PLACEHOLDERS: what your app does when Limenia reports a decision.
//
// Replace the log lines with your own code (e.g. Firestore updates). Make them
// idempotent: set a state instead of toggling it. Log IDs only, never texts.
//
// Optional: with LIMENIA_DISABLE_FIREBASE_USERS=true a ban or suspension also
// disables the Firebase Auth user and revokes their sessions, and restore
// enables them again. (Limenia can also do this itself with its Firebase
// connector, set up in the dashboard; then leave this option off.)

import { getAuth } from "firebase-admin/auth";
import { logger } from "firebase-functions";

const disableUsers = () => process.env.LIMENIA_DISABLE_FIREBASE_USERS === "true";

async function setDisabled(uid, disabled) {
  if (!disableUsers()) return;
  try {
    await getAuth().updateUser(uid, { disabled });
    if (disabled) await getAuth().revokeRefreshTokens(uid);
  } catch (err) {
    if (err?.code === "auth/user-not-found") return; // deleted in the meantime: nothing to do
    throw err;
  }
}

export const actions = {
  async removeContent(contentId) {
    logger.info("remove content", { contentId });
  },
  async restrictContent(contentId) {
    logger.info("restrict content", { contentId });
  },
  async restoreContent(contentId) {
    logger.info("restore content", { contentId });
  },
  async publishSubmission(contentId, { restricted = false } = {}) {
    logger.info("publish submitted content", { contentId, restricted });
  },
  async rejectSubmission(contentId) {
    logger.info("do not publish submitted content", { contentId });
  },

  async warnUser(uid) {
    logger.info("warn user", { uid });
  },
  async suspendUser(uid, until) {
    // Lift it at `until` yourself (e.g. a scheduled task); subject.status_changed can come up to an hour later.
    logger.info("suspend user", { uid, until });
    await setDisabled(uid, true);
  },
  async banUser(uid) {
    logger.info("ban user", { uid });
    await setDisabled(uid, true);
  },
  async restoreAccount(uid) {
    logger.info("unblock account", { uid });
    await setDisabled(uid, false);
  },
  async setAccountStatus(uid, status, suspendedUntil) {
    logger.info("set account status", { uid, status, suspendedUntil });
    await setDisabled(uid, status === "banned" || status === "suspended");
  },

  async notifyAffectedUser(uid, decision) {
    // Show decision.statementOfReasons.text as plain text, e.g. by e-mail if the account is disabled.
    logger.info("send statement of reasons", { uid, decisionId: decision.id });
  },
  async notifyReporters(reports) {
    logger.info("notify reporters", { decisionId: reports.decisionId, count: reports.items?.length ?? 0 });
  },
  async notifyAppellant(appeal) {
    logger.info("send answer to complaint", { appealId: appeal.id, outcome: appeal.outcome });
  },
};
