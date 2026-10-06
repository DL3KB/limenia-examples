// deno-lint-ignore-file require-await -- placeholders stay async; your code will await.
// PLACEHOLDERS: what your app does when Limenia reports a decision.
//
// Replace the log lines with your own code (e.g. update your tables). Make them
// idempotent: set a state instead of toggling it. Log IDs only, never texts.
//
// Optional: with LIMENIA_BAN_SUPABASE_USERS=true a ban or suspension also bans the
// Supabase Auth user (supabase.auth.admin.updateUserById with ban_duration), and
// restore lifts it again ("none"). This needs the service role key, which stays
// in the Edge Functions. The externalUserId must then be the Supabase user ID.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Actions } from "./events.ts";

const log = (msg: string, ids: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...ids }));

/** ban_duration for supabase.auth.admin.updateUserById: hours until `until`, "none" to lift. */
export function banDuration(until: string | undefined, now = Date.now()): string {
  if (!until) return "876000h"; // permanent ban: about 100 years
  const hours = Math.ceil((Date.parse(until) - now) / 3_600_000);
  return hours > 0 ? `${hours}h` : "none";
}

export function createActions(admin: () => SupabaseClient, banUsers = Deno.env.get("LIMENIA_BAN_SUPABASE_USERS") === "true"): Actions {
  async function setBan(userId: string, duration: string) {
    if (!banUsers) return;
    const { error } = await admin().auth.admin.updateUserById(userId, { ban_duration: duration });
    if (error && error.status !== 404) throw error; // a deleted user needs nothing
  }

  return {
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
      log("suspend user", { userId, until });
      await setBan(userId, until ? banDuration(until) : "none");
    },
    async banUser(userId) {
      log("ban user", { userId });
      await setBan(userId, banDuration(undefined));
    },
    async restoreAccount(userId) {
      log("unblock account", { userId });
      await setBan(userId, "none");
    },
    async setAccountStatus(userId, status, suspendedUntil) {
      log("set account status", { userId, status, suspendedUntil });
      if (status === "active" || status === "warned") await setBan(userId, "none");
      else if (status === "suspended" && suspendedUntil) await setBan(userId, banDuration(suspendedUntil));
      else if (status === "banned") await setBan(userId, banDuration(undefined));
    },
    async notifyAffectedUser(userId, decision) {
      // Show decision.statementOfReasons.text as plain text, e.g. by e-mail if the account is banned.
      log("send statement of reasons", { userId, decisionId: decision.id });
    },
    async notifyReporters(reports) {
      log("notify reporters", { decisionId: reports.decisionId, count: reports.items?.length ?? 0 });
    },
    async notifyAppellant(appeal) {
      log("send answer to complaint", { appealId: appeal.id, outcome: appeal.outcome });
    },
  };
}
