/**
 * Tests for the reflector gate (2026-11-19): with reflectorEnabled, an
 * agent's wait/complete records a pending request instead of flipping
 * the goal's status; the reflector session records its verdict via the
 * verdict action (reflector-only, eval-id checked); the push routes
 * through the injected scheduleSessionTurn on the api route.
 * Run: npm test (builds first, then node --test test/*.test.mjs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { openRegistry, getGoal } from "../dist/registry.js";
import { handleGoalAction, DEFAULT_CONFIG } from "../dist/goal.js";
import { pushContinuation } from "../dist/push.js";
import { isReflectorSession, reflectorSessionKey, parseReflectorVerdict } from "../dist/reflector.js";

function memDb() {
  return openRegistry(":memory:");
}

const stubJudge = async () => ({ verdict: "done", reason: "ok", parseFailed: false, transportFailed: false });
const KEY = "agent:tony:main";
const REFLECTOR = "agent:tony:goal-reflect";

async function makeGoal(db) {
  const r = await handleGoalAction(db, KEY, "tony", {
    action: "create", objective: "Ship the public release and get first customers",
    acceptance_criteria: "Release live on the store",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(r.ok, true, `create failed: ${JSON.stringify(r)}`);
}

test("gate: wait records a pending request and does NOT park the goal", async () => {
  const db = memDb();
  await makeGoal(db);
  const r = await handleGoalAction(db, KEY, "tony", {
    action: "wait", on: "subagents", reason: "workers are on it",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(r.ok, true);
  assert.equal(r.validation_pending, true);
  const g = getGoal(db, KEY);
  assert.equal(g.status, "active", "the agent cannot park its own goal");
  assert.equal(g.pendingRequest?.kind, "wait");
  assert.equal(g.pendingRequest?.on, "subagents");
  assert.equal(g.pendingRequest?.reason, "workers are on it");
  // A second request while one is pending is refused.
  const again = await handleGoalAction(db, KEY, "tony", {
    action: "wait", on: "seconds", seconds: 60,
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(again.ok, false);
  db.close();
});

test("gate: wait validation still applies (bad params refused, nothing recorded)", async () => {
  const db = memDb();
  await makeGoal(db);
  const bad = await handleGoalAction(db, KEY, "tony", { action: "wait", on: "seconds" }, DEFAULT_CONFIG, stubJudge);
  assert.equal(bad.ok, false);
  assert.equal(getGoal(db, KEY).pendingRequest, null);
  const badOn = await handleGoalAction(db, KEY, "tony", { action: "wait", on: "nonsense" }, DEFAULT_CONFIG, stubJudge);
  assert.equal(badOn.ok, false);
  db.close();
});

test("gate: complete records a pending request and does NOT close the goal", async () => {
  const db = memDb();
  await makeGoal(db);
  const r = await handleGoalAction(db, KEY, "tony", {
    action: "complete", evidence: "Release v1.0 is live on the store: https://example.com/release",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(r.ok, true);
  assert.equal(r.validation_pending, true);
  const g = getGoal(db, KEY);
  assert.equal(g.status, "active", "a completion claim does not close the goal on its own");
  assert.equal(g.pendingRequest?.kind, "complete");
  db.close();
});

test("gate: legacy mode (reflectorEnabled=false) still parks immediately", async () => {
  const db = memDb();
  const LEGACY = { ...DEFAULT_CONFIG, reflectorEnabled: false };
  await handleGoalAction(db, KEY, "tony", {
    action: "create", objective: "Ship the public release and get first customers",
  }, LEGACY, stubJudge);
  const r = await handleGoalAction(db, KEY, "tony", {
    action: "wait", on: "seconds", seconds: 120,
  }, LEGACY, stubJudge);
  assert.equal(r.ok, true);
  assert.equal(r.waiting, true);
  const g = getGoal(db, KEY);
  assert.equal(g.status, "waiting");
  assert.equal(g.waitingOn, "seconds");
  assert.ok(g.waitingUntil > Date.now());
  db.close();
});

test("verdict: only a reflector session can record one, eval id must match", async () => {
  const db = memDb();
  await makeGoal(db);
  await handleGoalAction(db, KEY, "tony", {
    action: "wait", on: "subagents", reason: "workers are on it",
  }, DEFAULT_CONFIG, stubJudge);
  // Simulate the plugin dispatching the evaluation.
  const g0 = getGoal(db, KEY);
  g0.pendingEval = { evalId: "eval-1", kind: "wait", dispatchedAt: Date.now(), response: "workers are on it" };
  const { saveGoal } = await import("../dist/registry.js");
  saveGoal(db, g0);
  // A working session cannot grade.
  const selfGraded = await handleGoalAction(db, KEY, "tony", {
    action: "verdict", target_session_key: KEY, eval_id: "eval-1", verdict: "wait", decision: "approve", reason: "trust me",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(selfGraded.ok, false);
  // Wrong eval id is refused.
  const wrongId = await handleGoalAction(db, REFLECTOR, "tony", {
    action: "verdict", target_session_key: KEY, eval_id: "eval-999", verdict: "wait", decision: "approve", reason: "looks fine",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(wrongId.ok, false);
  // Another agent's reflector cannot grade this agent's goal.
  const foreign = await handleGoalAction(db, "agent:monica:goal-reflect", "monica", {
    action: "verdict", target_session_key: KEY, eval_id: "eval-1", verdict: "wait", decision: "approve", reason: "looks fine",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(foreign.ok, false);
  // The real reflector records the verdict — on the row, status untouched.
  const recorded = await handleGoalAction(db, REFLECTOR, "tony", {
    action: "verdict", target_session_key: KEY, eval_id: "eval-1", verdict: "continue", decision: "deny",
    reason: "linked issue still open and two dispatchable items remain",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  const g = getGoal(db, KEY);
  assert.equal(g.status, "active", "recording a verdict never flips status — the plugin applies it");
  assert.equal(g.pendingEval?.verdict?.decision, "deny");
  assert.match(g.pendingEval?.verdict?.reason ?? "", /still open/);
  // A second verdict for the same eval is refused.
  const twice = await handleGoalAction(db, REFLECTOR, "tony", {
    action: "verdict", target_session_key: KEY, eval_id: "eval-1", verdict: "wait", decision: "approve", reason: "changed my mind",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(twice.ok, false);
  db.close();
});

test("verdict: reflector sessions cannot own goals", async () => {
  const db = memDb();
  const r = await handleGoalAction(db, REFLECTOR, "tony", {
    action: "create", objective: "Grade all the goals forever and ever",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(r.ok, false);
  assert.equal(getGoal(db, REFLECTOR), null);
  db.close();
});

test("reflector helpers: session keys and reply-text verdict parsing", () => {
  assert.equal(reflectorSessionKey("tony"), "agent:tony:goal-reflect");
  assert.equal(isReflectorSession("agent:tony:goal-reflect"), true);
  assert.equal(isReflectorSession("agent:tony:main"), false);
  const v = parseReflectorVerdict('Ruling:\n{"verdict": "continue", "decision": "deny", "reason": "issue still open"}');
  assert.equal(v?.verdict, "continue");
  assert.equal(v?.decision, "deny");
  assert.equal(parseReflectorVerdict("no json at all"), null);
  assert.equal(parseReflectorVerdict(""), null);
});

test("push: api route goes through the injected scheduleSessionTurn", async () => {
  const calls = [];
  const scheduleTurn = async (args) => { calls.push(args); return { ok: true, detail: "scheduled" }; };
  const r = await pushContinuation("tony", KEY, "wake up", {
    cliPath: "openclaw", timeoutSeconds: 30, route: "api", scheduleTurn,
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionKey, KEY);
  assert.equal(calls[0].message, "wake up");
  // API route without the API surface fails loudly, never silently via CLI.
  const noApi = await pushContinuation("tony", KEY, "wake up", {
    cliPath: "openclaw", timeoutSeconds: 30, route: "api",
  });
  assert.equal(noApi.ok, false);
  assert.match(noApi.detail, /unavailable/);
  // A scheduling failure propagates.
  const failing = async () => ({ ok: false, detail: "cron rejected" });
  const failed = await pushContinuation("tony", KEY, "wake up", {
    cliPath: "openclaw", timeoutSeconds: 30, route: "api", scheduleTurn: failing,
  });
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /cron rejected/);
});
