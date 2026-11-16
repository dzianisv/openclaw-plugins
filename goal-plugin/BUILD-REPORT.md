# Goal plugin for OpenClaw — build report (2026-11-16, end of day)

## What was built

Two plugins, one mechanism (tool + registry + Judge + push). Both live in
`/home/engineer/.openclaw/` on dev-1; local copies in `~/workspace/goal-plugin/`
and `~/workspace/goal-tool/`.

### `goal` plugin — the turn-end Judge + push (definePluginEntry, agent_end hook)
- `src/index.ts` — registers the `agent_end` hook only (no tool; see below).
- `src/registry.ts` — SQLite registry (`goal.db` in the OpenClaw state dir).
  One row per session, keyed to the session KEY (`agent:<id>:main`) — stable,
  survives compaction. The live goal state lives ONLY here, never in a file.
- `src/judge.ts` — the Judge: a separate one-shot model call
  (`openclaw capability model run`, default model `openai/gpt-6.1-sol`).
  Parses `{"verdict": "done|continue|blocked|wait", "reason": ...}`.
- `src/goal.ts` — the tool handler (`handleGoalAction`: get/create/link/
  complete/wait/resume/clear) + `evaluateTurnEnd` (judge → wait/blocked/done
  → parse-failure limit → stall check → turn budget → push) + `setUserGoal`.
  Stall detector: word-set Jaccard >= 0.85, pause after 5 stalled turns.
  Judge-outage pause: after 3 consecutive transport failures.
- `src/push.ts` — the push: continuation prompt via `openclaw agent`
  (agentTurn) into the idle session. Retry on "active run" up to 3x.
- `src/prompts.ts` — Judge prompts + continuation prompt + tool description.
- `test/decision.test.mjs` — 11 unit tests. `scripts/goal-admin.mjs` —
  operator CLI (set-user-goal / get / list / clear).

### `goal-tool` plugin — the `goal` tool (defineToolPlugin)
- `src/index.ts` — the `goal` tool via `defineToolPlugin`. The tool is a
  factory bound to the calling session's sessionKey/agentId. Shares the
  registry + handler with the `goal` plugin (imports from
  `../goal-plugin/dist/`).
- `openclaw.plugin.json` — declares `"contracts": {"tools": ["goal"]}`.
  **Required**: the gateway rejects tool registration with "plugin must
  declare contracts.tools before registering agent tools" if the manifest
  omits it.

## Why two plugins (the key finding)

`api.registerTool` inside a `definePluginEntry` does NOT expose a tool to
agents. The runtime only builds agents' tool lists from tools declared via
`defineToolPlugin` (the metadata is attached to the entry; the registry also
requires the manifest to declare `contracts.tools`). The factory was never
called and Tony got "Tool named `goal` is not available". The fix is the
separate `goal-tool` plugin (defineToolPlugin + contracts.tools). The `goal`
plugin no longer registers a tool — it only runs the hook.

Also discovered: OpenClaw 2026.11.2 HAS built-in goal tools
(`get_goal`, `create_goal`, `update_goal` in `src/agents/tools/goal-tools.ts`).
The spec's "OpenClaw has NO goal tool" was wrong. They are visible to the
agent. If the custom `goal` tool still does not appear, pivot the tool
surface to the built-in tools and have the Judge read OpenClaw's
session-goal store.

## Verified (live readback or test)

- Judge: correct verdicts live. `continue` with a concrete next step on
  partial progress; `continue` refusing DONE when the response claims
  completion but shows no evidence (no command output); `done` when the
  response shows the `cat` output proving the file exists with DONE.
  `complete` with weak evidence refused; with strong evidence completed.
- Registry: Tony + Monica user goals set and active (see below).
  Overwrite protection: an agent `create` against a user-set goal is refused
  ("the current goal was set by the user...") and the goal is unchanged.
- Judge-outage pause: a goal paused after 3 consecutive Judge failures
  ("goal judge unreachable 3 turns in a row — goal paused").
- Stall detector: same reply 5x → paused at the 5th stalled turn;
  varied replies keep the counter at 0.
- Turn-end hook fires live: Tony's goal went to turn 1/20, Monica's to
  turn 2/20, with real Judge verdicts recorded in the registry.
- Unit tests: 11/11 pass.

## NOT verified live (blocked)

- The `goal` tool callable by the agent live. The `goal-tool` plugin is
  built, registered, and loads (it appears in the gateway's 21-plugin list),
  but every live agentTurn I sent to test it was aborted or timed out
  because the gateway kept restarting (parallel cron-fix work) or was
  unresponsive (HTTP 000). The tool has NOT yet been seen in an agent turn.
- A successful push. The push was attempted several times (turn-end
  `push_failed` in the log) and failed each time because the gateway was
  down/unresponsive when the agentTurn ran. A successful push is not verified.
- Judge reliability: the Judge is flaky when the gateway is unresponsive
  (Tony's last verdict is `judge_unavailable` — "Unexpected end of JSON
  input" — because the gateway was shutting down mid-call). The Judge works
  when the gateway is up; it fails when the gateway is down. The outage
  counter + pause handle this, but the gateway flakiness is the root cause.

## Live goal state (registry, 2026-11-16 ~02:00 PST)

- Tony (`agent:product-lead-agentpod:main`): "Make Mallow public release
  ready, first $10K MRR" [active, user-set, turn 1/20].
- Monica (`agent:product-lead-vibebrowser:main`): "Ship VibeBrowser public
  release ready, first $10K MRR" [active, user-set, turn 2/20].
- Test goals (goal-test, goal-test2, goal-stall-test, goal-stall-test2)
  cleared (status cancelled).

## Operational notes

- Do NOT use `openclaw plugins reload goal` (or goal-tool) to load new code.
  The plugin host waits only 5s to drain, but the Judge takes ~60s and the
  push takes minutes, so the reload fails with "Previous plugin cleanup
  failed" and can leave the plugin retired. Load new code with a gateway
  restart.
- Judge model: `openai/gpt-6.1-sol` (default). The free deepseek model is
  monthly-limit-exhausted until ~Dec 3, 2026. Switch judgeModel to
  `opencode-go/deepseek-v4.1-flash` when the limit resets.
- Judge timeout is 120s (the model call takes ~60-70s on the loaded VM;
  the agent_end hook is fire-and-forget so the Judge may run past the ~30s
  hook budget).
- The gateway is intermittently HTTP 000 / restarting (parallel cron-fix
  work). That flakiness is what blocks the final live verification, not the
  plugin code.

## Spec acceptance criteria (section 5) — status

1. Goal tool callable by an agent — NOT verified live (tool built + loaded,
   but no live agent call has succeeded yet; blocked by gateway restarts).
   Handler + registry + complete-refuse/complete verified by unit tests
   and dry-run.
2. User-set goal cannot be overwritten — VERIFIED live.
3. Goal survives compaction/rotation — verified by design + unit test
   (keyed to stable sessionKey). Not verified by an actual live compaction.
4. Stall detector pauses a non-progressing goal — VERIFIED (test; 5x same
   reply → paused; varied replies → counter stays 0).
5. Judge outage pauses after N failures — VERIFIED live (mechanism).
6. Criteria checked against the original user ask — VERIFIED by unit test
   (judge prompt carries the user ask + the rule that weaker criteria mean
   NOT done) and live (Judge refused DONE on weak evidence).
7. Goal text is NOT in any file — PARTIAL. Live state is in the registry
   (goal.db), no GOAL_STATE.md exists. BUT Tony's generated AGENTS.md still
   has a standing "## GOAL — public release ready, first $10K MRR" section
   (from the AGENTS.md generator). Removing it requires editing the generator
   (Mallow repo) — out of scope; flag as a parent decision.
8. No inference job exists to nudge the agent — HOLDS (no such job created;
   the push comes from the turn-end hook, not a cron job).
9. Heartbeat continues an active goal — NOT verifiable yet (heartbeat was
   frozen; the mechanism is the tool description telling the agent to call
   `get` at the start of every turn).
10. Tony and Monica both have the mechanism, each with their own goal —
    goals set for both (active); mechanism installed gateway-wide;
    per-criterion verification as listed above.
