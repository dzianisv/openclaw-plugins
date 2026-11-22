/**
 * Unit tests for goal(get) on a miss: a bare null made every supervisor
 * tick conclude "the goal registry was wiped" (8 loss events, Nov 21–22),
 * when the row may simply live under another session key. get must say
 * WHY it is missing — sibling goals under other keys, or genuinely none.
 * Run: npm test (builds first, then node --test test/*.test.mjs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openRegistry, newGoalRow, saveGoal } from "../dist/registry.js";
import { handleGoalAction, DEFAULT_CONFIG } from "../dist/goal.js";

function memDb() {
  return openRegistry(":memory:");
}

async function stubJudge() {
  return { verdict: "continue", reason: "stub", parseFailed: false, transportFailed: false };
}

function seedMainGoal(db) {
  const g = newGoalRow("agent:product-lead-agentpod:main", "product-lead-agentpod");
  g.goal = "Make Mallow public release ready, first $10K MRR";
  g.source = "user";
  g.status = "active";
  g.turnsUsed = 11;
  g.maxTurns = 20;
  saveGoal(db, g);
  return g;
}

test("get miss with a sibling goal names the sibling instead of a bare null", async () => {
  const db = memDb();
  seedMainGoal(db);
  const res = await handleGoalAction(
    db,
    "agent:product-lead-agentpod:supervisor",
    "product-lead-agentpod",
    { action: "get" },
    DEFAULT_CONFIG,
    stubJudge,
  );
  assert.equal(res.ok, true);
  assert.equal(res.goal, null);
  assert.match(res.missing_reason, /other session key/);
  assert.equal(res.sibling_goals.length, 1);
  assert.equal(res.sibling_goals[0].session_key, "agent:product-lead-agentpod:main");
  assert.equal(res.sibling_goals[0].status, "active");
  assert.equal(res.sibling_goals[0].source, "user");
  assert.equal(res.sibling_goals[0].turns_used, 11);
});

test("get miss from a cron session says cron sessions cannot own goals", async () => {
  const db = memDb();
  seedMainGoal(db);
  const res = await handleGoalAction(
    db,
    "cron_95afd72a-0404-4ba5-981e-f7ab84d38cb3",
    "product-lead-agentpod",
    { action: "get" },
    DEFAULT_CONFIG,
    stubJudge,
  );
  assert.equal(res.ok, true);
  assert.equal(res.goal, null);
  assert.match(res.missing_reason, /other session key/);
  assert.equal(res.sibling_goals.length, 1);
  assert.match(res.note, /cron sessions cannot own goals/);
});

test("get miss with no goals at all says the registry is empty for this agent", async () => {
  const db = memDb();
  const res = await handleGoalAction(
    db,
    "agent:product-lead-agentpod:main",
    "product-lead-agentpod",
    { action: "get" },
    DEFAULT_CONFIG,
    stubJudge,
  );
  assert.equal(res.ok, true);
  assert.equal(res.goal, null);
  assert.equal(res.missing_reason, "no goal registered for this agent in any session");
  assert.equal(res.sibling_goals, undefined);
});

test("get miss never exposes another agent's goals", async () => {
  const db = memDb();
  seedMainGoal(db);
  const res = await handleGoalAction(
    db,
    "agent:product-lead-vibebrowser:main",
    "product-lead-vibebrowser",
    { action: "get" },
    DEFAULT_CONFIG,
    stubJudge,
  );
  assert.equal(res.ok, true);
  assert.equal(res.goal, null);
  assert.equal(res.missing_reason, "no goal registered for this agent in any session");
});

test("get hit is unchanged — no sibling fields on a found goal", async () => {
  const db = memDb();
  seedMainGoal(db);
  const res = await handleGoalAction(
    db,
    "agent:product-lead-agentpod:main",
    "product-lead-agentpod",
    { action: "get" },
    DEFAULT_CONFIG,
    stubJudge,
  );
  assert.equal(res.ok, true);
  assert.equal(res.goal, "Make Mallow public release ready, first $10K MRR");
  assert.equal(res.turns_used, 11);
  assert.equal(res.missing_reason, undefined);
  assert.equal(res.sibling_goals, undefined);
});
