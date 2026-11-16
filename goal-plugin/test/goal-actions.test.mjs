/**
 * Unit tests for the Muse-mirroring management actions
 * (list / search / update / set_status / create_entry / update_entry /
 * delete_entry / delete) and the entries registry column.
 * Run: npm test (builds first, then node --test test/*.test.mjs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openRegistry, getGoal, saveGoal } from "../dist/registry.js";
import { handleGoalAction, DEFAULT_CONFIG, setUserGoal as setUserGoalAction } from "../dist/goal.js";

function memDb() {
  return openRegistry(":memory:");
}

const stubJudge = async () => ({ verdict: "done", reason: "ok", parseFailed: false, transportFailed: false });

async function makeGoal(db, key, agentId, objective = "Ship the public release and get first customers") {
  const r = await handleGoalAction(db, key, agentId, {
    action: "create", objective, acceptance_criteria: "Release live on the store",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(r.ok, true, `create failed: ${JSON.stringify(r)}`);
  return r;
}

test("list: returns only the calling agent's non-cancelled goals", async () => {
  const db = memDb();
  await makeGoal(db, "agent:tony:main", "tony", "Ship Mallow public release ready now");
  await makeGoal(db, "agent:tony:other", "tony", "Grow Mallow to ten thousand MRR fast");
  await makeGoal(db, "agent:monica:main", "monica", "Ship VibeBrowser public release ready");
  const listed = await handleGoalAction(db, "agent:tony:main", "tony", { action: "list" }, DEFAULT_CONFIG, stubJudge);
  assert.equal(listed.ok, true);
  assert.equal(listed.goals.length, 2);
  assert.ok(listed.goals.every((g) => g.goal.includes("Mallow")));
  assert.ok(listed.goals.every((g) => typeof g.status_line === "string" && g.status_line.length > 0));
  assert.equal(listed.goals[0].status, "active");
  // Cancelled goals are not listed.
  await handleGoalAction(db, "agent:tony:other", "tony", { action: "clear" }, DEFAULT_CONFIG, stubJudge);
  const again = await handleGoalAction(db, "agent:tony:main", "tony", { action: "list" }, DEFAULT_CONFIG, stubJudge);
  assert.equal(again.goals.length, 1);
  assert.equal(again.goals[0].session_key, "agent:tony:main");
  db.close();
});

test("search: matches goal text, criteria, and entry titles/descriptions", async () => {
  const db = memDb();
  await makeGoal(db, "agent:tony:main", "tony", "Ship Mallow public release ready now");
  await makeGoal(db, "agent:tony:other", "tony", "Write the quarterly report for investors");
  // Give the second goal different criteria so the criteria-match is unambiguous.
  await handleGoalAction(db, "agent:tony:other", "tony", {
    action: "update", acceptance_criteria: "Investor deck delivered on time",
  }, DEFAULT_CONFIG, stubJudge);
  const byGoal = await handleGoalAction(db, "agent:tony:main", "tony", { action: "search", query: "mallow" }, DEFAULT_CONFIG, stubJudge);
  assert.equal(byGoal.goals.length, 1);
  const byCriteria = await handleGoalAction(db, "agent:tony:main", "tony", { action: "search", query: "STORE" }, DEFAULT_CONFIG, stubJudge);
  assert.equal(byCriteria.goals.length, 1, "search is case-insensitive and matches acceptance criteria");
  const noMatch = await handleGoalAction(db, "agent:tony:main", "tony", { action: "search", query: "zebra" }, DEFAULT_CONFIG, stubJudge);
  assert.equal(noMatch.goals.length, 0);
  const tooShort = await handleGoalAction(db, "agent:tony:main", "tony", { action: "search", query: "x" }, DEFAULT_CONFIG, stubJudge);
  assert.equal(tooShort.ok, false, "query under 2 chars is refused");
  // Entry text is searchable.
  const created = await handleGoalAction(db, "agent:tony:main", "tony", {
    action: "create_entry", title: "Beta feedback", current_state: "open", description: "Testers want a dark mode toggle",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(created.ok, true);
  const byEntry = await handleGoalAction(db, "agent:tony:main", "tony", { action: "search", query: "dark mode" }, DEFAULT_CONFIG, stubJudge);
  assert.equal(byEntry.goals.length, 1);
  db.close();
});

test("update: agent goal updates + revision bump; user-set goal refused", async () => {
  const db = memDb();
  await makeGoal(db, "agent:tony:main", "tony", "Ship Mallow public release ready now");
  const before = getGoal(db, "agent:tony:main");
  const updated = await handleGoalAction(db, "agent:tony:main", "tony", {
    action: "update", objective: "Ship Mallow public release and first paying customers",
    acceptance_criteria: "Release live; first $10K MRR reached", max_turns: 30,
    subgoals: ["Release live on the store", "First $10K MRR"],
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(updated.ok, true);
  assert.equal(updated.goal, "Ship Mallow public release and first paying customers");
  assert.equal(updated.acceptance_criteria, "Release live; first $10K MRR reached");
  assert.equal(getGoal(db, "agent:tony:main").revision, before.revision + 1);
  assert.equal(getGoal(db, "agent:tony:main").maxTurns, 30);
  const empty = await handleGoalAction(db, "agent:tony:main", "tony", { action: "update" }, DEFAULT_CONFIG, stubJudge);
  assert.equal(empty.ok, false, "update with no fields is refused");
  // User-set goal: refused, unchanged.
  setUserGoalAction(db, "agent:monica:main", "monica",
    "Ship VibeBrowser public release ready", "Release live", "Store listing live", "Ship VibeBrowser");
  const refused = await handleGoalAction(db, "agent:monica:main", "monica", {
    action: "update", objective: "A different objective the agent wants",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(refused.ok, false);
  assert.match(String(refused.error), /set by the user/);
  assert.equal(getGoal(db, "agent:monica:main").goal, "Ship VibeBrowser public release ready");
  db.close();
});

test("set_status: completed keeps the row, active reopens; reason required; user-set refused", async () => {
  const db = memDb();
  await makeGoal(db, "agent:tony:main", "tony", "Ship Mallow public release ready now");
  const noReason = await handleGoalAction(db, "agent:tony:main", "tony", {
    action: "set_status", status: "completed",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(noReason.ok, false, "reason is required");
  const badStatus = await handleGoalAction(db, "agent:tony:main", "tony", {
    action: "set_status", status: "paused", reason: "x",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(badStatus.ok, false, "only active|completed are accepted");
  const done = await handleGoalAction(db, "agent:tony:main", "tony", {
    action: "set_status", status: "completed", reason: "Release is live, MRR goal hit",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(done.ok, true);
  assert.equal(done.status, "done");
  const row = getGoal(db, "agent:tony:main");
  assert.ok(row, "completed keeps the row");
  assert.equal(row.goal, "Ship Mallow public release ready now");
  assert.equal(row.lastReason, "Release is live, MRR goal hit");
  const reopened = await handleGoalAction(db, "agent:tony:main", "tony", {
    action: "set_status", status: "active", reason: "MRR dropped below the threshold",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(reopened.ok, true);
  assert.equal(reopened.status, "active");
  assert.equal(getGoal(db, "agent:tony:main").status, "active");
  // User-set goal: refused (use complete, audited, to finish it).
  setUserGoalAction(db, "agent:monica:main", "monica",
    "Ship VibeBrowser public release ready", "Release live", "Store listing live", "Ship VibeBrowser");
  const refused = await handleGoalAction(db, "agent:monica:main", "monica", {
    action: "set_status", status: "completed", reason: "It is done",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(refused.ok, false);
  assert.equal(getGoal(db, "agent:monica:main").status, "active");
  db.close();
});

test("entries: create_entry / update_entry / delete_entry round-trip, persisted in the registry", async () => {
  const db = memDb();
  await makeGoal(db, "agent:tony:main", "tony", "Ship Mallow public release ready now");
  const created = await handleGoalAction(db, "agent:tony:main", "tony", {
    action: "create_entry", title: "Week 1", current_state: "on track",
    description: "Release candidate built, store listing drafted",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(created.ok, true);
  assert.ok(typeof created.entry_id === "string" && created.entry_id.length > 0);
  assert.equal(created.entries.length, 1);
  assert.equal(created.entries[0].title, "Week 1");
  // Persisted, not just in the response: a fresh read sees it.
  assert.equal(getGoal(db, "agent:tony:main").entries.length, 1);
  assert.equal(getGoal(db, "agent:tony:main").entries[0].description, "Release candidate built, store listing drafted");
  const id = created.entry_id;
  const noTitle = await handleGoalAction(db, "agent:tony:main", "tony", {
    action: "create_entry", current_state: "open",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(noTitle.ok, false, "create_entry needs title");
  const updated = await handleGoalAction(db, "agent:tony:main", "tony", {
    action: "update_entry", update_id: id, title: "Week 1 (revised)", current_state: "blocked",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(updated.ok, true);
  assert.equal(updated.entry.title, "Week 1 (revised)");
  assert.equal(updated.entry.current_state, "blocked");
  assert.equal(updated.entry.description, "Release candidate built, store listing drafted", "untouched fields stay");
  const emptyUpdate = await handleGoalAction(db, "agent:tony:main", "tony", {
    action: "update_entry", update_id: id,
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(emptyUpdate.ok, false, "update_entry needs at least one field");
  const missing = await handleGoalAction(db, "agent:tony:main", "tony", {
    action: "update_entry", update_id: "no-such-id", title: "x",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(missing.ok, false);
  const deleted = await handleGoalAction(db, "agent:tony:main", "tony", {
    action: "delete_entry", update_id: id,
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(deleted.ok, true);
  assert.equal(getGoal(db, "agent:tony:main").entries.length, 0);
  const deletedAgain = await handleGoalAction(db, "agent:tony:main", "tony", {
    action: "delete_entry", update_id: id,
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(deletedAgain.ok, false, "deleting a missing entry is refused");
  db.close();
});

test("delete: refused without confirm=true; refused for a user-set goal; removes the row when confirmed", async () => {
  const db = memDb();
  await makeGoal(db, "agent:tony:main", "tony", "Ship Mallow public release ready now");
  const unconfirmed = await handleGoalAction(db, "agent:tony:main", "tony", { action: "delete" }, DEFAULT_CONFIG, stubJudge);
  assert.equal(unconfirmed.ok, false);
  assert.match(String(unconfirmed.error), /confirm=true/);
  assert.ok(getGoal(db, "agent:tony:main"), "row still there after refused delete");
  setUserGoalAction(db, "agent:monica:main", "monica",
    "Ship VibeBrowser public release ready", "Release live", "Store listing live", "Ship VibeBrowser");
  const userSet = await handleGoalAction(db, "agent:monica:main", "monica", {
    action: "delete", confirm: true,
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(userSet.ok, false);
  assert.match(String(userSet.error), /set by the user/);
  assert.ok(getGoal(db, "agent:monica:main"), "user-set row still there");
  const deleted = await handleGoalAction(db, "agent:tony:main", "tony", {
    action: "delete", confirm: true,
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(deleted.ok, true);
  assert.equal(getGoal(db, "agent:tony:main"), null);
  db.close();
});

test("registry: a pre-entries DB (old schema) gains the column on open", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-migration-"));
  const dbPath = join(dir, "goal.db");
  // Build a DB exactly as the old schema did (no entries column).
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE goals (
      session_key TEXT PRIMARY KEY, agent_id TEXT NOT NULL DEFAULT '',
      goal TEXT NOT NULL DEFAULT '', acceptance_criteria TEXT NOT NULL DEFAULT '',
      verification TEXT NOT NULL DEFAULT '', user_ask TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active', source TEXT NOT NULL DEFAULT 'agent',
      linked_task_ids TEXT NOT NULL DEFAULT '[]', subgoals TEXT NOT NULL DEFAULT '[]',
      gates TEXT NOT NULL DEFAULT '[]', max_turns INTEGER NOT NULL DEFAULT 20,
      turns_used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0, last_verdict TEXT NOT NULL DEFAULT '',
      last_reason TEXT NOT NULL DEFAULT '', last_response_snippet TEXT NOT NULL DEFAULT '',
      consecutive_stalled INTEGER NOT NULL DEFAULT 0,
      consecutive_transport_failures INTEGER NOT NULL DEFAULT 0,
      consecutive_parse_failures INTEGER NOT NULL DEFAULT 0,
      judge_outage_alerted INTEGER NOT NULL DEFAULT 0,
      waiting_on TEXT NOT NULL DEFAULT '', waiting_reason TEXT NOT NULL DEFAULT '',
      waiting_until INTEGER NOT NULL DEFAULT 0,
      pending_human_decisions TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO goals (session_key, agent_id, goal) VALUES ('agent:old:main', 'old', 'Old goal text');
  `);
  old.close();
  const db = openRegistry(dbPath);
  const g = getGoal(db, "agent:old:main");
  assert.equal(g?.goal, "Old goal text");
  assert.deepEqual(g?.entries, []);
  // Saving now writes entries without error, and they read back.
  assert.ok(g);
  g.entries = [{ id: "e1", title: "t", current_state: "s", description: "d", effective_at: 1 }];
  saveGoal(db, g);
  assert.equal(getGoal(db, "agent:old:main")?.entries.length, 1);
  assert.equal(getGoal(db, "agent:old:main")?.entries[0].title, "t");
  db.close();
});
