/**
 * Unit tests for the goal plugin's pure logic (no gateway, no model).
 * Run: npm test (builds first, then node --test test/*.test.mjs).
 * The Judge and push are exercised live (CLI), not here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openRegistry, getGoal, saveGoal, newGoalRow } from "../dist/registry.js";
import { parseJudgeResponse } from "../dist/judge.js";
import {
  handleGoalAction, responseSimilarity, normalizeSnippet, DEFAULT_CONFIG,
} from "../dist/goal.js";
import { buildJudgeUserPrompt, buildContinuationPrompt } from "../dist/prompts.js";

function memDb() {
  return openRegistry(":memory:");
}

test("judge: parses done / blocked / continue / wait", () => {
  assert.equal(parseJudgeResponse('{"verdict": "done", "reason": "shipped"}').verdict, "done");
  assert.equal(parseJudgeResponse('{"verdict": "blocked", "blocker": "transient", "reason": "CI running"}').blocker, "transient");
  assert.equal(parseJudgeResponse('{"verdict": "blocked", "blocker": "human_only", "human_category": "money", "human_decision": "Approve $50?", "reason": "needs money"}').humanCategory, "money");
  assert.equal(parseJudgeResponse('{"verdict": "wait", "wait_for_seconds": 600, "reason": "CI"}').waitForSeconds, 600);
  assert.equal(parseJudgeResponse('{"verdict": "continue", "reason": "more work"}').verdict, "continue");
});

test("judge: legacy shape and unparseable output", () => {
  assert.equal(parseJudgeResponse('{"done": true, "reason": "ok"}').verdict, "done");
  assert.equal(parseJudgeResponse('{"done": false, "reason": "no"}').verdict, "continue");
  const bad = parseJudgeResponse("no json here at all");
  assert.equal(bad.parseFailed, true);
  assert.equal(bad.verdict, "continue");
  const wrapped = parseJudgeResponse('Here is my verdict:\n{"verdict": "done", "reason": "x"}\nDone.');
  assert.equal(wrapped.verdict, "done");
});

test("similarity: identical high, different low", () => {
  const a = "I dispatched the card and verified the merge on main.";
  assert.ok(responseSimilarity(a, a) > 0.99);
  assert.ok(responseSimilarity(a, "I dispatched the card and verified the merge on main today.") > 0.85);
  assert.ok(responseSimilarity(a, "The weather in Bali is sunny and warm.") < 0.3);
});

test("registry: create/get round-trips, keyed by session key", () => {
  const db = memDb();
  const g = newGoalRow("agent:product-lead-agentpod:main", "product-lead-agentpod");
  g.goal = "Ship Mallow public release";
  g.acceptanceCriteria = "Release is live on the store";
  g.userAsk = "Make Mallow public release ready";
  saveGoal(db, g);
  const back = getGoal(db, "agent:product-lead-agentpod:main");
  assert.equal(back?.goal, "Ship Mallow public release");
  assert.equal(back?.userAsk, "Make Mallow public release ready");
  assert.equal(getGoal(db, "agent:other:main"), null);
  // A different (rotated) session id for the same agent does NOT lose the goal:
  // the goal is keyed to the stable session KEY, not the rotating id.
  assert.equal(getGoal(db, "agent:product-lead-agentpod:main")?.goal, "Ship Mallow public release");
  db.close();
});

test("tool: create validates objective length, get returns null first", async () => {
  const db = memDb();
  const stubJudge = async () => ({ verdict: "done", reason: "ok", parseFailed: false, transportFailed: false });
  const key = "agent:test:main";
  const empty = await handleGoalAction(db, key, "test", { action: "get" }, DEFAULT_CONFIG, stubJudge);
  assert.equal(empty.goal, null);
  const short = await handleGoalAction(db, key, "test", { action: "create", objective: "too short" }, DEFAULT_CONFIG, stubJudge);
  assert.equal(short.ok, false);
  const created = await handleGoalAction(db, key, "test", {
    action: "create", objective: "Ship the public release and get first customers",
    acceptance_criteria: "Release live on the store", user_ask: "Ship it",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(created.ok, true);
  assert.equal(created.goal, "Ship the public release and get first customers");
  const again = await handleGoalAction(db, key, "test", {
    action: "create", objective: "A different objective that is long enough",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(again.ok, false, "second create without replace must refuse");
  const replaced = await handleGoalAction(db, key, "test", {
    action: "create", objective: "A different objective that is long enough", replace: true,
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(replaced.ok, true);
  db.close();
});

test("tool: cron sessions cannot set a goal", async () => {
  const db = memDb();
  const stubJudge = async () => ({ verdict: "done", reason: "ok", parseFailed: false, transportFailed: false });
  const r = await handleGoalAction(db, "cron_abc123", "test", {
    action: "create", objective: "A goal that is long enough to pass",
  }, DEFAULT_CONFIG, stubJudge);
  assert.equal(r.ok, false);
  db.close();
});

test("tool: complete refuses when the judge says not done, completes when done", async () => {
  // Legacy synchronous path (reflector off): the one-shot judge audits
  // complete inline. The reflector gate has its own tests
  // (reflector-gate.test.mjs).
  const LEGACY = { ...DEFAULT_CONFIG, reflectorEnabled: false };
  const db = memDb();
  const key = "agent:test:main";
  const stubContinue = async () => ({ verdict: "continue", reason: "not yet", parseFailed: false, transportFailed: false });
  await handleGoalAction(db, key, "test", {
    action: "create", objective: "Ship the public release and get first customers",
    acceptance_criteria: "Release live",
  }, LEGACY, stubContinue);
  const refused = await handleGoalAction(db, key, "test", {
    action: "complete", evidence: "I did some work on the release today",
  }, LEGACY, stubContinue);
  assert.equal(refused.ok, false);
  assert.match(String(refused.error), /refused/);
  const stubDone = async () => ({ verdict: "done", reason: "release is live", parseFailed: false, transportFailed: false });
  const done = await handleGoalAction(db, key, "test", {
    action: "complete", evidence: "Release v1.0 is live on the store: https://example.com/release",
  }, LEGACY, stubDone);
  assert.equal(done.ok, true);
  assert.equal(getGoal(db, key)?.status, "done");
  db.close();
});

test("tool: complete unverified when the judge is unreachable", async () => {
  const LEGACY = { ...DEFAULT_CONFIG, reflectorEnabled: false };
  const db = memDb();
  const key = "agent:test:main";
  const stubOk = async () => ({ verdict: "done", reason: "ok", parseFailed: false, transportFailed: false });
  await handleGoalAction(db, key, "test", {
    action: "create", objective: "Ship the public release and get first customers",
  }, LEGACY, stubOk);
  const stubDown = async () => ({ verdict: "continue", reason: "judge error: 429", parseFailed: false, transportFailed: true });
  const r = await handleGoalAction(db, key, "test", {
    action: "complete", evidence: "Release is live on the store now",
  }, LEGACY, stubDown);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /unverified/);
  assert.equal(getGoal(db, key)?.status, "active", "goal stays open");
  db.close();
});

test("prompts: judge prompt carries the user ask (bug-4 fix)", () => {
  const p = buildJudgeUserPrompt({
    goal: "Ship the release",
    response: "Done.",
    acceptanceCriteria: "Release live",
    userAsk: "Ship the release AND get 10 paying customers",
  });
  assert.match(p, /Original user ask/);
  assert.match(p, /10 paying customers/);
  assert.match(p, /Acceptance criteria|Completion contract/);
});

test("prompts: continuation prompt is a self-wake, not a user message", () => {
  const p = buildContinuationPrompt({ goal: "Ship the release", acceptanceCriteria: "Release live" });
  assert.match(p, /self-wake, not a user message/);
  assert.match(p, /Goal: Ship the release/);
  assert.match(p, /Acceptance criteria: Release live/);
});

test("normalizeSnippet truncates and collapses whitespace", () => {
  assert.equal(normalizeSnippet("  a   b\nc  "), "a b c");
  assert.equal(normalizeSnippet("x".repeat(5000)).length, 2000);
});
