import assert from "node:assert/strict";
import { test } from "node:test";
import { handleEvent } from "../src/events.js";

function setup() {
  const done = [];
  const actions = new Proxy({}, { get: (_, name) => async (...args) => done.push([name, ...args]) });
  const seen = new Set();
  const store = { isProcessed: async (id) => seen.has(id), markProcessed: async (id) => seen.add(id) };
  return { done, deps: { actions, store } };
}
const app = { id: "app_1", slug: "demo" };
const decision = (id, fields) => ({ id, type: "decision.created", createdAt: "2026-10-01T10:00:00Z", app, decision: { id: `d_${id}`, policies: [], statementOfReasons: { text: "..." }, decidedAt: "2026-10-01T10:00:00Z", ...fields } });

test("ban is applied once; the duplicate is skipped", async () => {
  const { done, deps } = setup();
  const e = decision("evt_1", { action: "ban_user", subject: { externalUserId: "uid_1" } });
  assert.equal(await handleEvent(e, deps), "processed");
  assert.equal(await handleEvent(e, deps), "duplicate");
  assert.deepEqual(done.map((d) => d[0]), ["banUser", "notifyAffectedUser"]);
});

test("decisions with reviewId never touch the account", async () => {
  const { done, deps } = setup();
  await handleEvent(decision("evt_2", { action: "reject_submission", reviewId: "rv", subject: { externalUserId: "u" }, content: { externalContentId: "c" } }), deps);
  await handleEvent(decision("evt_3", { action: "restore", restoreScope: "content", reviewId: "rv", subject: { externalUserId: "u" }, content: { externalContentId: "c" } }), deps);
  await handleEvent(decision("evt_4", { action: "suspend_user", reviewId: "rv", subject: { externalUserId: "u" } }), deps);
  const names = done.map((d) => d[0]);
  assert.ok(!names.some((n) => ["suspendUser", "banUser", "restoreAccount", "warnUser"].includes(n)));
  assert.deepEqual(names.filter((n) => n !== "notifyAffectedUser"), ["rejectSubmission", "publishSubmission"]);
});

test("restore follows restoreScope", async () => {
  const { done, deps } = setup();
  await handleEvent(decision("evt_5", { action: "restore", restoreScope: "account", subject: { externalUserId: "u" }, content: { externalContentId: "c" } }), deps);
  await handleEvent(decision("evt_6", { action: "restore", restoreScope: "content", subject: { externalUserId: "u" }, content: { externalContentId: "c" } }), deps);
  assert.deepEqual(done.map((d) => d[0]).filter((n) => n !== "notifyAffectedUser"), ["restoreAccount", "restoreContent"]);
});

test("other and unknown event types", async () => {
  const { done, deps } = setup();
  assert.equal(await handleEvent({ id: "e1", type: "subject.status_changed", app, subject: { externalUserId: "u", status: "active" } }, deps), "processed");
  assert.equal(await handleEvent({ id: "e2", type: "appeal.resolved", app, appeal: { id: "a", outcome: "upheld" } }, deps), "processed");
  assert.equal(await handleEvent({ id: "e3", type: "reports.resolved", app, reports: { decisionId: "d", items: [] } }, deps), "processed");
  assert.equal(await handleEvent({ id: "e4", type: "review.decided", app, review: { id: "r", outcome: "approved", content: { externalContentId: "c" } } }, deps), "processed");
  assert.equal(await handleEvent({ id: "e5", type: "test.ping", app }, deps), "processed");
  assert.equal(await handleEvent({ id: "e6", type: "brand.new", app }, deps), "ignored");
  assert.deepEqual(done.map((d) => d[0]), ["setAccountStatus", "notifyAppellant", "notifyReporters", "publishSubmission"]);
});
