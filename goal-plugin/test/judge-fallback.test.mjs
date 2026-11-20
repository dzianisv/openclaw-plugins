/**
 * Unit tests for the judge fallback chain (2026-11-20, Run 6).
 * The judge tries the configured model first, then each fallback in
 * order, and only reports a transport failure when EVERY model fails
 * (2026-11-19: beam-free 429'd and every verdict came back
 * judge_unavailable). The model runner is stubbed via the runModel
 * test seam — no gateway, no live model.
 * Run: npm test (builds first, then node --test test/*.test.mjs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { judgeGoal } from "../dist/judge.js";

const INPUT = {
  goal: "Ship the release",
  response: "Release v1.5.54 is live",
  acceptanceCriteria: "Release live",
  verification: "",
  userAsk: "",
  subgoals: [],
};

function opts(calls, behavior) {
  return {
    agentId: "product-lead-agentpod",
    judgeModel: "opencode-go/beam-free",
    fallbackModels: ["openrouter/nvidia/nemotron-3.5-super-vl:free"],
    cliPath: "openclaw",
    timeoutMs: 120_000,
    runModel: async (model) => {
      calls.push(model);
      const fn = behavior[model];
      if (!fn) throw new Error(`no stub for ${model}`);
      return fn();
    },
  };
}

test("judge: falls back to the next model when the first 429s", async () => {
  const calls = [];
  const r = await judgeGoal(INPUT, opts(calls, {
    "opencode-go/beam-free": () => { throw new Error("429 rate_limit_error"); },
    "openrouter/nvidia/nemotron-3.5-super-vl:free": () => '{"verdict": "done", "reason": "shipped"}',
  }));
  assert.equal(r.verdict, "done");
  assert.equal(r.transportFailed, false);
  assert.deepEqual(calls, ["opencode-go/beam-free", "openrouter/nvidia/nemotron-3.5-super-vl:free"]);
});

test("judge: transport failure only when every model fails, reason names each", async () => {
  const calls = [];
  const r = await judgeGoal(INPUT, opts(calls, {
    "opencode-go/beam-free": () => { throw new Error("429 rate_limit_error"); },
    "openrouter/nvidia/nemotron-3.5-super-vl:free": () => { throw new Error("timeout"); },
  }));
  assert.equal(r.verdict, "continue");
  assert.equal(r.transportFailed, true);
  assert.match(r.reason, /beam-free/);
  assert.match(r.reason, /super-vl/);
  assert.deepEqual(calls, ["opencode-go/beam-free", "openrouter/nvidia/nemotron-3.5-super-vl:free"]);
});

test("judge: first model succeeding means no fallback call", async () => {
  const calls = [];
  const r = await judgeGoal(INPUT, opts(calls, {
    "opencode-go/beam-free": () => '{"verdict": "continue", "reason": "more work"}',
    "openrouter/nvidia/nemotron-3.5-super-vl:free": () => { throw new Error("must not be called"); },
  }));
  assert.equal(r.verdict, "continue");
  assert.equal(r.transportFailed, false);
  assert.deepEqual(calls, ["opencode-go/beam-free"]);
});

test("judge: a duplicated model is tried once", async () => {
  const calls = [];
  const r = await judgeGoal(INPUT, {
    agentId: "product-lead-agentpod",
    judgeModel: "openrouter/nvidia/nemotron-3.5-super-vl:free",
    fallbackModels: ["openrouter/nvidia/nemotron-3.5-super-vl:free"],
    cliPath: "openclaw",
    timeoutMs: 120_000,
    runModel: async (model) => {
      calls.push(model);
      return '{"verdict": "done", "reason": "shipped"}';
    },
  });
  assert.equal(r.verdict, "done");
  assert.deepEqual(calls, ["openrouter/nvidia/nemotron-3.5-super-vl:free"]);
});

test("judge: empty output on the first model falls through to the next", async () => {
  const calls = [];
  const r = await judgeGoal(INPUT, opts(calls, {
    "opencode-go/beam-free": () => "   ",
    "openrouter/nvidia/nemotron-3.5-super-vl:free": () => '{"verdict": "wait", "wait_for_seconds": 600, "reason": "CI"}',
  }));
  assert.equal(r.verdict, "wait");
  assert.equal(r.waitForSeconds, 600);
  assert.equal(r.transportFailed, false);
  assert.deepEqual(calls, ["opencode-go/beam-free", "openrouter/nvidia/nemotron-3.5-super-vl:free"]);
});

test("judge: no fallback configured, single model failing still reports transport failure", async () => {
  const calls = [];
  const r = await judgeGoal(INPUT, {
    agentId: "product-lead-agentpod",
    judgeModel: "opencode-go/beam-free",
    cliPath: "openclaw",
    timeoutMs: 120_000,
    runModel: async (model) => {
      calls.push(model);
      throw new Error("429 rate_limit_error");
    },
  });
  assert.equal(r.transportFailed, true);
  assert.deepEqual(calls, ["opencode-go/beam-free"]);
});
