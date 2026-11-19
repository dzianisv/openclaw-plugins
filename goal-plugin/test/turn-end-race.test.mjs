/**
 * Unit tests for the W16 turn-end race fix (no gateway, no model).
 * Run: npm test (builds first, then node --test test/*.test.mjs).
 *
 * The race (observed 2026-11-19 08:31–08:41 WITA on Monica's session):
 * six turn-end evaluations overlapped through the ~60s judge call; a
 * pause written at 08:39:48 did not stop pushes at 08:40:53 + 08:41:21,
 * which charged turns 11→13 on a paused goal. The fix has two layers:
 *   (1) PerSessionQueue — evaluations for one session run one at a time;
 *   (2) evaluateTurnEnd re-gates on the fresh registry row after the
 *       judge call — a pause written mid-judge stops the push, charges
 *       no turn, and the stale copy is never written back over it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { openRegistry, getGoal, saveGoal, newGoalRow } from "../dist/registry.js";
import { evaluateTurnEnd, DEFAULT_CONFIG } from "../dist/goal.js";
import { PerSessionQueue } from "../dist/turn-end-queue.js";

function memDb() {
  return openRegistry(":memory:");
}

function activeGoal(db, sessionKey = "agent:test:main", agentId = "test") {
  const g = newGoalRow(sessionKey, agentId);
  g.goal = "Ship the thing";
  g.acceptanceCriteria = "It is live";
  g.userAsk = "Ship the thing";
  g.status = "active";
  saveGoal(db, g);
  return g;
}

// dryRun: the push decision is recorded, no CLI call is made.
const cfg = { ...DEFAULT_CONFIG, dryRun: true };
const pushOpts = { cliPath: "openclaw", timeoutSeconds: 300 };
const judgeOpts = { agentId: "test", judgeModel: cfg.judgeModel, cliPath: "openclaw", timeoutMs: 120000 };

const continueJudge = async () => ({
  verdict: "continue", reason: "more work", parseFailed: false, transportFailed: false,
});

test("re-gate: a pause written while the judge runs stops the push and charges no turn", async () => {
  const db = memDb();
  activeGoal(db);
  // Simulate a concurrent evaluation pausing the goal mid-judge
  // (the 08:39:48 pause): the judge's own verdict is "continue".
  const pausingJudge = async () => {
    const cur = getGoal(db, "agent:test:main");
    cur.status = "paused";
    cur.lastVerdict = "blocked";
    cur.lastReason = "judged unachievable: needs money";
    saveGoal(db, cur);
    return { verdict: "continue", reason: "more work", parseFailed: false, transportFailed: false };
  };
  const d = await evaluateTurnEnd(db, "agent:test:main", "test", "did some work", cfg, judgeOpts, pushOpts, pausingJudge);
  assert.equal(d.action, "skipped");
  const after = getGoal(db, "agent:test:main");
  assert.equal(after.status, "paused"); // the pause was NOT clobbered back to active
  assert.equal(after.turnsUsed, 0); // no turn charged for a push that must not happen
  assert.equal(after.lastVerdict, "blocked"); // the pausing verdict survives, not the stale "continue"
  db.close();
});

test("re-gate: an unchanged active goal still pushes (dry run) and charges one turn", async () => {
  const db = memDb();
  activeGoal(db);
  const d = await evaluateTurnEnd(db, "agent:test:main", "test", "did some work", cfg, judgeOpts, pushOpts, continueJudge);
  assert.equal(d.action, "pushed");
  const after = getGoal(db, "agent:test:main");
  assert.equal(after.status, "active");
  assert.equal(after.turnsUsed, 1);
  assert.equal(after.lastVerdict, "continue");
  db.close();
});

test("race: two overlapping evaluations — the second sees the pause and does not push", async () => {
  const db = memDb();
  activeGoal(db);
  const slowContinue = async () => {
    await new Promise((r) => setTimeout(r, 50));
    return { verdict: "continue", reason: "more work", parseFailed: false, transportFailed: false };
  };
  const blockingJudge = async () => ({
    verdict: "blocked", blocker: "human_only", humanCategory: "money",
    humanDecision: "Approve $50?", reason: "needs money",
    parseFailed: false, transportFailed: false,
  });
  const [first, second] = await Promise.all([
    evaluateTurnEnd(db, "agent:test:main", "test", "work one", cfg, judgeOpts, pushOpts, blockingJudge),
    evaluateTurnEnd(db, "agent:test:main", "test", "work two", cfg, judgeOpts, pushOpts, slowContinue),
  ]);
  assert.equal(first.action, "paused");
  assert.equal(second.action, "skipped");
  const after = getGoal(db, "agent:test:main");
  assert.equal(after.status, "paused");
  assert.equal(after.turnsUsed, 0);
  db.close();
});

test("queue: same-session tasks run one at a time, in order; other sessions run in parallel", async () => {
  const q = new PerSessionQueue();
  const order = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  q.run("agent:a:main", async () => { order.push("a1-start"); await sleep(30); order.push("a1-end"); });
  q.run("agent:a:main", async () => { order.push("a2-start"); order.push("a2-end"); });
  q.run("agent:b:main", async () => { order.push("b1-start"); await sleep(10); order.push("b1-end"); });
  await sleep(120);
  // a2 starts only after a1 ends (same session serialized) …
  assert.ok(order.indexOf("a2-start") > order.indexOf("a1-end"));
  // … while b runs in parallel with a (b ends before a does).
  assert.ok(order.indexOf("b1-end") < order.indexOf("a1-end"));
  assert.equal(q.size, 0);
});

test("queue: a throwing task does not block the next task for the session", async () => {
  const q = new PerSessionQueue();
  const ran = [];
  q.run("agent:a:main", async () => { throw new Error("boom"); });
  q.run("agent:a:main", async () => { ran.push("second"); });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(ran, ["second"]);
  assert.equal(q.size, 0);
});
