/**
 * The goal tool handler + the turn-end evaluation.
 *
 * Tool actions (mirroring Hermes tools/goal_tool.py GOAL_SCHEMA, plus a
 * `resume` action — an OpenClaw addition, since Hermes resumes via the
 * /goal command which OpenClaw has no equivalent of — plus the Muse
 * management actions list / search / update / set_status / create_entry /
 * update_entry / delete_entry / delete):
 *   get, create, link, complete, wait, resume, clear,
 *   list, search, update, set_status, create_entry, update_entry, delete_entry, delete
 *
 * Scoping: every action works on the CALLING session's goal, EXCEPT
 * list/search, which list goals visible to the caller — goals for sessions
 * of the same agent id. Another agent's goals are never exposed. The one
 * deliberate exception is `verdict`: a reflector session
 * (agent:<id>:goal-reflect) records its ruling on the pending evaluation
 * of a goal owned by the SAME agent — it writes the verdict only, never
 * the status; the plugin applies verdicts and owns status transitions.
 *
 * Reflector gate (2026-11-19): with cfg.reflectorEnabled, `wait` and
 * `complete` do not change the goal's status. They record a
 * PendingRequest on the row and return "validation pending"; the plugin
 * dispatches the request to the agent's reflector session and applies it
 * only on an approving verdict. The operator route (setUserGoal /
 * goal-admin) is unaffected and still writes directly.
 *
 * User-set goals (source=user) can only be changed by the user/operator
 * (setUserGoal / goal-admin). The agent's update / set_status / delete on
 * a user-set goal are refused — the same overwrite protection as create.
 * Muse's delete_briefing has no OpenClaw equivalent and is not mirrored.
 *
 * Turn-end evaluation (the reactive wake, Den's design): when the agent
 * ends a turn, the Judge evaluates the goal. Unlike Hermes (where agent
 * goals are NEVER judged per turn — bug 2), this judges EVERY goal at
 * every turn-end, agent goals included. If not reached, PUSH a
 * continuation prompt into the idle session. The push IS the wake.
 *
 * Order (mirrors Hermes evaluate_after_turn, with the agent-goal fix):
 *   judge -> re-gate on the fresh registry row (W16: a pause written
 *   while the judge ran is authoritative — no push, no turn charged) ->
 *   wait/blocked/done -> parse-failure limit -> stall check ->
 *   turn budget -> push.
 */
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  getGoal, saveGoal, deleteGoal, listGoalsForAgent, newGoalRow, statusLine,
  type GoalRow, type GoalEntry, type PendingRequest,
} from "./registry.js";
import { judgeGoal, type JudgeOptions } from "./judge.js";
import { pushContinuation, type PushOptions } from "./push.js";
import { buildContinuationPrompt } from "./prompts.js";
import { isReflectorSession } from "./reflector.js";

export const MIN_OBJECTIVE_CHARS = 12;
export const MAX_OBJECTIVE_CHARS = 600;

export interface GoalConfig {
  judgeModel: string;
  /**
   * Models tried in order after judgeModel when the judge call fails on
   * transport (429, timeout, CLI error). Empty means "the built-in
   * default judge model" (see judgeOptsFor in index.ts) — a bad config
   * override can never strand a verdict.
   */
  judgeFallbackModels: string[];
  judgeTimeoutMs: number;
  maxStalledTurns: number;
  maxJudgeOutages: number;
  maxParseFailures: number;
  defaultMaxTurns: number;
  cliPath: string;
  pushTimeoutSeconds: number;
  nudgeEnabled: boolean;
  nudgeIntervalMinutes: number;
  nudgeInitialDelaySeconds: number;
  /**
   * Reflector mode (2026-11-19): turn-end grading and wait/complete
   * validation run in the agent's standing reflector session instead of
   * the one-shot judge, and an agent's wait/complete is recorded as a
   * pending request — the status flips only when the plugin applies an
   * approving verdict. When false, the legacy synchronous paths run
   * (one-shot judge; wait/complete apply immediately).
   */
  reflectorEnabled: boolean;
  /** Push route: "api" = api.session.workflow.scheduleSessionTurn; "cli" = openclaw agent subprocess. */
  pushRoute: "api" | "cli";
  /** Seconds a reflector evaluation may run before the one-shot judge fallback resolves it. */
  verdictTimeoutSeconds: number;
  dryRun: boolean;
}

export const DEFAULT_CONFIG: GoalConfig = {
  judgeModel: "openrouter/nvidia/nemotron-3.5-super-vl:free",
  // No explicit fallbacks by default: judgeOptsFor substitutes the
  // built-in default judge model (Super-VL free) as the fallback, so a
  // configured judgeModel that 429s still degrades to a known-good model.
  judgeFallbackModels: [],
  // The Judge is a model call on a loaded VM (~60-70s). The agent_end hook
  // is fire-and-forget, so the Judge may run longer than the ~30s hook
  // budget — the budget bounds the await, not the background work.
  judgeTimeoutMs: 120_000,
  maxStalledTurns: 5,
  maxJudgeOutages: 3,
  maxParseFailures: 3,
  defaultMaxTurns: 20,
  cliPath: "openclaw",
  pushTimeoutSeconds: 300,
  nudgeEnabled: true,
  nudgeIntervalMinutes: 30,
  nudgeInitialDelaySeconds: 120,
  reflectorEnabled: true,
  pushRoute: "api",
  verdictTimeoutSeconds: 300,
  dryRun: false,
};

export type ToolResult = { ok: boolean; error?: string; [k: string]: unknown };

function ok(payload: Record<string, unknown>): ToolResult {
  return { ok: true, ...payload };
}
function fail(error: string, extra: Record<string, unknown> = {}): ToolResult {
  return { ok: false, error, ...extra };
}

export function goalView(g: GoalRow | null): Record<string, unknown> {
  if (!g) return { goal: null };
  const view: Record<string, unknown> = {
    goal: g.goal,
    status: g.status,
    source: g.source,
    turns_used: g.turnsUsed,
    max_turns: g.maxTurns,
    last_verdict: g.lastVerdict,
    last_reason: g.lastReason,
  };
  if (g.acceptanceCriteria) view.acceptance_criteria = g.acceptanceCriteria;
  if (g.verification) view.verification = g.verification;
  if (g.linkedTaskIds.length > 0) view.linked_task_ids = g.linkedTaskIds;
  if (g.subgoals.length > 0) view.subgoals = g.subgoals;
  if (g.entries.length > 0) view.entries = g.entries;
  if (g.pendingHumanDecisions.length > 0) view.pending_human_decisions = g.pendingHumanDecisions;
  if (g.pendingRequest) {
    view.pending_validation = {
      kind: g.pendingRequest.kind,
      reason: g.pendingRequest.reason,
      requested_at: g.pendingRequest.requestedAt,
    };
  }
  if (g.lastDenial) view.last_denial = g.lastDenial;
  if (g.waitingReason) view.waiting = g.waitingReason;
  view.status_line = statusLine(g);
  return view;
}

/** The compact view list/search return per goal (no full row, no entries). */
export function goalListView(g: GoalRow): Record<string, unknown> {
  return {
    session_key: g.sessionKey,
    goal: g.goal,
    status: g.status,
    source: g.source,
    turns_used: g.turnsUsed,
    last_verdict: g.lastVerdict,
    status_line: statusLine(g),
  };
}

export interface GoalActionParams {
  action: string;
  objective?: string;
  evidence?: string;
  acceptance_criteria?: string;
  verification?: string;
  user_ask?: string;
  replace?: boolean;
  task_ids?: string[];
  max_turns?: number;
  on?: string;
  process_session?: string;
  seconds?: number;
  question?: string;
  reason?: string;
  // Muse-mirroring management actions:
  query?: string;
  status?: string;
  confirm?: boolean;
  update_id?: string;
  title?: string;
  current_state?: string;
  description?: string;
  effective_at?: number;
  subgoals?: string[];
  // Reflector verdict action (reflector sessions only):
  target_session_key?: string;
  eval_id?: string;
  verdict?: string;
  decision?: string;
  blocker?: string;
  human_category?: string;
  human_decision?: string;
  wait_for_seconds?: number;
}

function isCronSession(sessionKey: string): boolean {
  return sessionKey.startsWith("cron_");
}

/**
 * Set a goal directly (the user side — Den sets the goal). A user-set goal
 * always wins and cannot be replaced by the agent's create. Used by the
 * operator (via a CLI or agentTurn) to set Tony's / Monica's goal.
 */
export function setUserGoal(
  db: DatabaseSync,
  sessionKey: string,
  agentId: string,
  objective: string,
  acceptanceCriteria: string,
  verification: string,
  userAsk: string,
): GoalRow {
  const existing = getGoal(db, sessionKey);
  const g = existing ?? newGoalRow(sessionKey, agentId);
  g.agentId = agentId;
  g.goal = objective.trim();
  g.acceptanceCriteria = (acceptanceCriteria || "").trim();
  g.verification = (verification || "").trim();
  g.userAsk = (userAsk || objective).trim();
  g.status = "active";
  g.source = "user";
  g.turnsUsed = 0;
  g.consecutiveStalled = 0;
  g.consecutiveTransportFailures = 0;
  g.consecutiveParseFailures = 0;
  g.judgeOutageAlerted = false;
  g.waitingOn = "";
  g.waitingReason = "";
  g.waitingUntil = 0;
  g.pendingHumanDecisions = [];
  g.revision += 1;
  saveGoal(db, g);
  return g;
}

/**
 * Apply a wait request to the goal row (the legacy wait mutations, shared
 * by the direct path and by the plugin when a reflector verdict approves
 * a pending request). Caller saves.
 */
export function applyWaitRequest(g: GoalRow, req: PendingRequest): void {
  g.status = "waiting";
  g.waitingOn = req.on || "";
  if (req.on === "seconds") {
    const secs = req.seconds && req.seconds > 0 ? req.seconds : 600;
    g.waitingUntil = Date.now() + secs * 1000;
    g.waitingReason = req.reason || `waiting ${secs}s`;
  } else if (req.on === "process") {
    g.waitingReason = req.reason || `waiting on process ${req.processSession || ""}`;
  } else if (req.on === "user") {
    g.waitingReason = req.reason;
    g.pendingHumanDecisions = [...new Set([...g.pendingHumanDecisions, req.reason])];
  } else {
    g.waitingReason = req.reason || "waiting on delegated subagents";
  }
}

/** Append an audit entry to a goal row. Caller saves. */
export function addGoalEntry(g: GoalRow, title: string, description: string): void {
  g.entries = [
    ...g.entries,
    { id: randomUUID(), title, current_state: "", description, effective_at: Date.now() },
  ];
}

export async function handleGoalAction(
  db: DatabaseSync,
  sessionKey: string,
  agentId: string,
  params: GoalActionParams,
  cfg: GoalConfig,
  runJudge: (input: {
    goal: string; response: string; acceptanceCriteria?: string; verification?: string;
    userAsk?: string; subgoals?: string[]; evidence?: string;
  }) => Promise<{
    verdict: string; reason: string; parseFailed: boolean; transportFailed: boolean;
  }>,
): Promise<ToolResult> {
  const action = (params.action || "").trim();

  if (action === "get") {
    const g = getGoal(db, sessionKey);
    return ok(goalView(g));
  }

  if (action === "create") {
    if (isCronSession(sessionKey)) {
      return fail("cron runs are one-shot and have no goal loop; do the work in this turn instead of setting a goal");
    }
    if (isReflectorSession(sessionKey)) {
      return fail("reflector sessions do not own goals; they grade other sessions' goals and record verdicts with action=verdict");
    }
    const objective = (params.objective || "").trim();
    if (objective.length < MIN_OBJECTIVE_CHARS || objective.length > MAX_OBJECTIVE_CHARS) {
      return fail(`objective must be ${MIN_OBJECTIVE_CHARS}–${MAX_OBJECTIVE_CHARS} chars`);
    }
    const existing = getGoal(db, sessionKey);
    if (existing && existing.source === "user" && !params.replace) {
      return fail("the current goal was set by the user; it cannot be replaced by the agent — the user clears it", goalView(existing));
    }
    if (existing && existing.source === "user" && params.replace) {
      return fail("the current goal was set by the user; it cannot be replaced by the agent — the user clears it", goalView(existing));
    }
    if (existing && existing.status === "waiting" && existing.source === "agent" && !params.replace) {
      return fail("this session's goal is parked and still holds the slot; resume it or replace it with replace=true", goalView(existing));
    }
    if (existing && existing.status === "active" && !params.replace) {
      return fail("a goal is already set for this session; finish it with complete, or pass replace=true if it is your own goal and the user redirected you", goalView(existing));
    }
    const g = existing ?? newGoalRow(sessionKey, agentId);
    g.agentId = agentId;
    g.goal = objective;
    g.acceptanceCriteria = (params.acceptance_criteria || "").trim();
    g.verification = (params.verification || "").trim();
    // Record the user ask alongside the agent-written criteria (bug-4 fix):
    // the judge checks the criteria against the ask. The agent passes the
    // ask it is working from; when absent, the objective stands in for it.
    g.userAsk = (params.user_ask || objective).trim();
    g.status = "active";
    g.source = "agent";
    g.turnsUsed = 0;
    g.consecutiveStalled = 0;
    g.consecutiveTransportFailures = 0;
    g.consecutiveParseFailures = 0;
    g.judgeOutageAlerted = false;
    g.waitingOn = "";
    g.waitingReason = "";
    g.waitingUntil = 0;
    g.pendingHumanDecisions = [];
    if (params.max_turns && Number.isInteger(params.max_turns) && params.max_turns > 0) {
      g.maxTurns = params.max_turns;
    } else if (!existing) {
      g.maxTurns = cfg.defaultMaxTurns;
    }
    g.revision += 1;
    if (Array.isArray(params.task_ids) && params.task_ids.length > 0) {
      g.linkedTaskIds = [...new Set([...g.linkedTaskIds, ...params.task_ids.filter((t) => typeof t === "string")])];
    }
    saveGoal(db, g);
    return ok({ created: true, ...goalView(g) });
  }

  if (action === "link") {
    const ids = Array.isArray(params.task_ids) ? params.task_ids.filter((t) => typeof t === "string") : [];
    if (ids.length === 0) return fail("link needs task_ids");
    const g = getGoal(db, sessionKey);
    if (!g) return fail("no goal to link cards to");
    g.linkedTaskIds = [...new Set([...g.linkedTaskIds, ...ids])];
    saveGoal(db, g);
    return ok({ linked: true, ...goalView(g) });
  }

  if (action === "complete") {
    const g = getGoal(db, sessionKey);
    if (!g) return fail("no goal to complete");
    const evidence = (params.evidence || "").trim();
    if (evidence.length < MIN_OBJECTIVE_CHARS) return fail("complete needs evidence that the outcome exists");
    if (cfg.reflectorEnabled) {
      // Reflector gate (2026-11-19): a completion claim no longer closes
      // the goal on the spot. The request is recorded; the plugin sends
      // it to the reflector session, and the status flips only if the
      // reflector's verdict approves it. A denial is pushed back into
      // this session with the contradicting evidence.
      if (g.pendingRequest) {
        return fail(`a ${g.pendingRequest.kind} request is already awaiting validation — wait for the reflector's verdict`, goalView(g));
      }
      g.pendingRequest = { kind: "complete", reason: evidence, requestedAt: Date.now() };
      saveGoal(db, g);
      return ok({
        validation_pending: true,
        note: "completion recorded for reflector validation — the goal stays active until the reflector approves it; a denial will be pushed back into this session",
        ...goalView(g),
      });
    }
    const decision = await runJudge({
      goal: g.goal,
      response: evidence,
      acceptanceCriteria: g.acceptanceCriteria,
      verification: g.verification,
      userAsk: g.userAsk,
      subgoals: g.subgoals,
      evidence,
    });
    if (decision.transportFailed) {
      return fail(`completion unverified: judge unavailable (${decision.reason}); the goal stays open — retry complete later`, { verdict: "unverified", reason: decision.reason });
    }
    if (decision.verdict !== "done") {
      return fail(`completion audit refused: ${decision.verdict} — ${decision.reason}`, { verdict: decision.verdict, reason: decision.reason });
    }
    g.status = "done";
    g.lastVerdict = "done";
    g.lastReason = decision.reason;
    saveGoal(db, g);
    return ok({ completed: true, reason: decision.reason });
  }

  if (action === "wait") {
    const g = getGoal(db, sessionKey);
    if (!g || g.status !== "active") return fail("no active goal to wait on");
    const on = (params.on || "").trim().toLowerCase();
    const reason = (params.reason || "").trim();
    const req: PendingRequest = { kind: "wait", on, reason, requestedAt: Date.now() };
    if (on === "subagents") {
      req.reason = reason || "waiting on delegated subagents";
    } else if (on === "process") {
      if (!(params.process_session || "").trim()) return fail("wait on=process needs process_session");
      req.processSession = (params.process_session || "").trim();
      req.reason = reason || `waiting on process ${req.processSession}`;
    } else if (on === "seconds") {
      const secs = Number(params.seconds || 0);
      if (!Number.isFinite(secs) || secs <= 0) return fail("wait on=seconds needs seconds > 0");
      req.seconds = secs;
      req.reason = reason || `waiting ${secs}s`;
    } else if (on === "user") {
      const q = (params.question || reason || "").trim();
      if (!q) return fail("wait on=user needs a question");
      req.reason = q;
    } else {
      return fail("wait needs on=subagents|process|seconds|user");
    }
    if (cfg.reflectorEnabled) {
      // Reflector gate (2026-11-19): the agent cannot park its own goal.
      // The request is recorded; the plugin applies it only if the
      // reflector session's verdict approves it. Until then the goal
      // stays ACTIVE and keeps being driven.
      if (g.pendingRequest) {
        return fail(`a ${g.pendingRequest.kind} request is already awaiting validation — wait for the reflector's verdict`, goalView(g));
      }
      g.pendingRequest = req;
      saveGoal(db, g);
      return ok({
        validation_pending: true,
        on,
        note: "wait recorded for reflector validation — the goal stays active until the reflector approves the park; a denial will be pushed back into this session",
        ...goalView(g),
      });
    }
    applyWaitRequest(g, req);
    saveGoal(db, g);
    return ok({ ...goalView(g), waiting: true, on });
  }

  if (action === "verdict") {
    // Reflector-only: record the reflector session's ruling on the
    // pending evaluation of ANOTHER session's goal (same agent). This
    // writes the verdict onto the target goal's row; it never flips the
    // target's status — the plugin applies verdicts when the reflector's
    // turn ends, and it is the only writer of status transitions here.
    if (!isReflectorSession(sessionKey)) {
      return fail("verdict is a reflector-only action — working sessions cannot grade goals");
    }
    const targetKey = (params.target_session_key || "").trim();
    const evalId = (params.eval_id || "").trim();
    if (!targetKey || !evalId) return fail("verdict needs target_session_key and eval_id");
    const verdictRaw = (params.verdict || "").trim().toLowerCase();
    if (verdictRaw !== "done" && verdictRaw !== "continue" && verdictRaw !== "blocked" && verdictRaw !== "wait") {
      return fail("verdict needs verdict=done|continue|blocked|wait");
    }
    const reason = (params.reason || "").trim();
    if (!reason) return fail("verdict needs a reason citing the evidence");
    const target = getGoal(db, targetKey);
    if (!target) return fail(`no goal at ${targetKey}`);
    if (target.agentId !== agentId) return fail("a reflector grades only its own agent's goals");
    if (!target.pendingEval) return fail("no evaluation is in flight for that goal");
    if (target.pendingEval.evalId !== evalId) {
      return fail(`eval_id mismatch: the in-flight evaluation is ${target.pendingEval.evalId}`);
    }
    if (target.pendingEval.verdict) return fail("a verdict is already recorded for this evaluation");
    const decisionRaw = (params.decision || "").trim().toLowerCase();
    target.pendingEval = {
      ...target.pendingEval,
      verdict: {
        verdict: verdictRaw,
        reason,
        decision: decisionRaw === "approve" ? "approve" : decisionRaw === "deny" ? "deny" : undefined,
        blocker: (params.blocker || "").trim() || undefined,
        humanCategory: (params.human_category || "").trim() || undefined,
        humanDecision: (params.human_decision || "").trim() || undefined,
        waitForSeconds: typeof params.wait_for_seconds === "number" && params.wait_for_seconds > 0 ? params.wait_for_seconds : undefined,
        at: Date.now(),
      },
    };
    saveGoal(db, target);
    return ok({ recorded: true, target_session_key: targetKey, eval_id: evalId, verdict: verdictRaw });
  }

  if (action === "resume") {
    const g = getGoal(db, sessionKey);
    if (!g) return fail("no goal to resume");
    if (g.status !== "waiting" && g.status !== "paused") {
      return fail(`goal is ${g.status}, not waiting/paused — nothing to resume`, goalView(g));
    }
    g.status = "active";
    g.waitingOn = "";
    g.waitingReason = "";
    g.waitingUntil = 0;
    g.consecutiveStalled = 0;
    saveGoal(db, g);
    return ok({ resumed: true, ...goalView(g) });
  }

  if (action === "clear") {
    const g = getGoal(db, sessionKey);
    if (!g) return ok({ cleared: false, goal: null });
    g.status = "cancelled";
    saveGoal(db, g);
    return ok({ cleared: true });
  }

  if (action === "list") {
    // Scoping rule: only this agent's goals — never another agent's.
    // Cancelled goals are not listed (they are done with, not active work).
    const goals = listGoalsForAgent(db, agentId).filter((g) => g.status !== "cancelled");
    return ok({ goals: goals.map(goalListView) });
  }

  if (action === "search") {
    const query = (params.query || "").trim();
    if (query.length < 2) return fail("search needs query of at least 2 characters");
    const q = query.toLowerCase();
    const goals = listGoalsForAgent(db, agentId).filter((g) => g.status !== "cancelled");
    const matches = goals.filter((g) => {
      const hay = [
        g.goal,
        g.acceptanceCriteria,
        ...g.entries.flatMap((e) => [e.title, e.description]),
      ].join("\n").toLowerCase();
      return hay.includes(q);
    });
    return ok({ query, goals: matches.map(goalListView) });
  }

  if (action === "update") {
    const g = getGoal(db, sessionKey);
    if (!g) return fail("no goal to update");
    // Same overwrite protection as create: a user-set goal can only be
    // changed by the user/operator via setUserGoal.
    if (g.source === "user") {
      return fail("the current goal was set by the user; it cannot be changed by the agent — the user changes it", goalView(g));
    }
    const hasObjective = typeof params.objective === "string" && params.objective.trim().length > 0;
    const hasCriteria = typeof params.acceptance_criteria === "string";
    const hasVerification = typeof params.verification === "string";
    const hasMaxTurns = typeof params.max_turns === "number";
    const hasSubgoals = Array.isArray(params.subgoals);
    if (!hasObjective && !hasCriteria && !hasVerification && !hasMaxTurns && !hasSubgoals) {
      return fail("update needs at least one of objective/acceptance_criteria/verification/max_turns/subgoals");
    }
    if (hasObjective) {
      const objective = (params.objective as string).trim();
      if (objective.length < MIN_OBJECTIVE_CHARS || objective.length > MAX_OBJECTIVE_CHARS) {
        return fail(`objective must be ${MIN_OBJECTIVE_CHARS}–${MAX_OBJECTIVE_CHARS} chars`);
      }
      g.goal = objective;
    }
    if (hasCriteria) g.acceptanceCriteria = (params.acceptance_criteria as string).trim();
    if (hasVerification) g.verification = (params.verification as string).trim();
    if (hasMaxTurns && Number.isInteger(params.max_turns) && (params.max_turns as number) > 0) {
      g.maxTurns = params.max_turns as number;
    }
    if (hasSubgoals) {
      g.subgoals = (params.subgoals as unknown[]).filter((t): t is string => typeof t === "string");
    }
    g.revision += 1;
    saveGoal(db, g);
    return ok({ updated: true, ...goalView(g) });
  }

  if (action === "set_status") {
    const g = getGoal(db, sessionKey);
    if (!g) return fail("no goal to change status on");
    const status = (params.status || "").trim().toLowerCase();
    if (status !== "active" && status !== "completed") {
      return fail("set_status needs status=active|completed");
    }
    const reason = (params.reason || "").trim();
    if (!reason) return fail("set_status needs a non-empty reason");
    // Same protection as create: a user-set goal's status can only be
    // changed by the user. Exception: the user already cleared it (status
    // cancelled) — the goal is released, so the agent may reopen it.
    // To finish a user-set goal, use `complete` (audited), not set_status.
    if (g.source === "user" && g.status !== "cancelled") {
      return fail("the current goal was set by the user; its status can only be changed by the user — use complete (audited) to finish it", goalView(g));
    }
    if (status === "completed") {
      // Completed keeps the row + history (do NOT delete).
      g.status = "done";
    } else {
      // Reopens a done / cancelled / paused goal.
      g.status = "active";
      g.waitingOn = "";
      g.waitingReason = "";
      g.waitingUntil = 0;
      g.consecutiveStalled = 0;
    }
    g.lastReason = reason;
    g.revision += 1;
    saveGoal(db, g);
    return ok({ status: g.status, ...goalView(g) });
  }

  if (action === "create_entry") {
    const g = getGoal(db, sessionKey);
    if (!g) return fail("no goal to add an entry to");
    const title = (params.title || "").trim();
    if (!title) return fail("create_entry needs title");
    const entry: GoalEntry = {
      id: randomUUID(),
      title,
      current_state: (params.current_state || "").trim(),
      description: (params.description || "").trim(),
      effective_at: typeof params.effective_at === "number" && params.effective_at > 0
        ? params.effective_at
        : Date.now(),
    };
    g.entries = [...g.entries, entry];
    saveGoal(db, g);
    return ok({ entry_id: entry.id, entry, ...goalView(g) });
  }

  if (action === "update_entry") {
    const g = getGoal(db, sessionKey);
    if (!g) return fail("no goal to update an entry on");
    const id = (params.update_id || "").trim();
    if (!id) return fail("update_entry needs update_id");
    const entry = g.entries.find((e) => e.id === id);
    if (!entry) return fail(`no entry ${JSON.stringify(id)} on this goal`);
    const hasChange =
      typeof params.title === "string" ||
      typeof params.current_state === "string" ||
      typeof params.description === "string" ||
      typeof params.effective_at === "number";
    if (!hasChange) {
      return fail("update_entry needs at least one of title/current_state/description/effective_at");
    }
    if (typeof params.title === "string") entry.title = params.title.trim();
    if (typeof params.current_state === "string") entry.current_state = params.current_state.trim();
    if (typeof params.description === "string") entry.description = params.description.trim();
    if (typeof params.effective_at === "number" && params.effective_at > 0) {
      entry.effective_at = params.effective_at;
    }
    saveGoal(db, g);
    return ok({ updated: true, entry, ...goalView(g) });
  }

  if (action === "delete_entry") {
    const g = getGoal(db, sessionKey);
    if (!g) return fail("no goal to delete an entry from");
    const id = (params.update_id || "").trim();
    if (!id) return fail("delete_entry needs update_id");
    const before = g.entries.length;
    g.entries = g.entries.filter((e) => e.id !== id);
    if (g.entries.length === before) return fail(`no entry ${JSON.stringify(id)} on this goal`);
    saveGoal(db, g);
    return ok({ deleted: true, entry_id: id, ...goalView(g) });
  }

  if (action === "delete") {
    // Deleting removes the row entirely — only for mistakes / an explicit
    // user request. Finished goals should use set_status completed (or
    // complete) instead, which keeps the row + history.
    if (params.confirm !== true) {
      return fail("delete removes the goal permanently — pass confirm=true to confirm; finished goals should use set_status completed instead");
    }
    const g = getGoal(db, sessionKey);
    if (!g) return ok({ deleted: false, goal: null });
    // Same protection as create: the agent never deletes a user-set goal.
    if (g.source === "user") {
      return fail("the current goal was set by the user; it cannot be deleted by the agent — the user clears it", goalView(g));
    }
    deleteGoal(db, sessionKey);
    return ok({ deleted: true });
  }

  return fail(`unknown action ${JSON.stringify(action)}`);
}

/** Word-set Jaccard similarity (0..1). Hermes uses difflib SequenceMatcher; this is the close, dependency-free equivalent. */
export function responseSimilarity(a: string, b: string): number {
  const words = (s: string) =>
    new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0));
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

export function normalizeSnippet(response: string): string {
  return response.split(/\s+/).join(" ").trim().slice(0, 2000);
}

export interface TurnEndDecision {
  action: "skipped" | "done" | "paused" | "waiting" | "pushed" | "push_failed" | "continued_no_push";
  reason: string;
  verdict?: string;
}

/** The verdict shape the turn-end application consumes (JudgeResult is a superset). */
export interface TurnJudgeResult {
  verdict: string;
  reason: string;
  parseFailed: boolean;
  transportFailed: boolean;
  blocker?: string;
  humanCategory?: string;
  humanDecision?: string;
  waitForSeconds?: number;
}

/**
 * The turn-end evaluation. Called from the agent_end hook. Runs the Judge
 * on the goal (ALL goals, agent goals included — the Hermes bug-2 fix),
 * then decides: done / blocked-pause / wait-park / stall-pause /
 * budget-pause / judge-outage-pause / push the continuation prompt.
 */
export async function evaluateTurnEnd(
  db: DatabaseSync,
  sessionKey: string,
  agentId: string,
  lastResponse: string,
  cfg: GoalConfig,
  judgeOpts: JudgeOptions,
  pushOpts: PushOptions,
  judgeFn: (input: {
    goal: string; response: string; acceptanceCriteria?: string; verification?: string;
    userAsk?: string; subgoals?: string[]; evidence?: string;
  }) => Promise<TurnJudgeResult> = (input) => judgeGoal(input, judgeOpts),
): Promise<TurnEndDecision> {
  if (isCronSession(sessionKey)) return { action: "skipped", reason: "cron session" };
  let g = getGoal(db, sessionKey);
  if (!g) return { action: "skipped", reason: "no goal for this session" };
  if (g.status === "done" || g.status === "cancelled") return { action: "skipped", reason: `goal ${g.status}` };
  if (g.status === "paused") return { action: "skipped", reason: "goal paused" };
  if (g.status === "waiting") {
    // A seconds-wait whose timer elapsed resumes on the next turn-end.
    if (g.waitingOn === "seconds" && g.waitingUntil > 0 && Date.now() >= g.waitingUntil) {
      g.status = "active";
      g.waitingOn = "";
      g.waitingReason = "";
      g.waitingUntil = 0;
      saveGoal(db, g);
    } else {
      return { action: "skipped", reason: `goal waiting (${g.waitingOn})` };
    }
  }
  const response = (lastResponse || "").trim();
  if (!response) return { action: "skipped", reason: "empty response (nothing to evaluate)" };

  // Judge (separate model call). ALL goals, agent goals included.
  const judge = await judgeFn(
    {
      goal: g.goal,
      response,
      acceptanceCriteria: g.acceptanceCriteria,
      verification: g.verification,
      userAsk: g.userAsk,
      subgoals: g.subgoals,
    },
  );

  // W16 re-gate: the judge call takes ~60s, and the goal may have changed
  // while it ran — another evaluation may have paused or parked it, or
  // the agent may have updated it. Re-read the registry and continue
  // only if this goal is still active at this revision. A pause written
  // mid-judge is authoritative: return without writing the stale copy
  // back (saveGoal is a full-row upsert — a stale save would write
  // `active` over the pause), without charging a turn, and without
  // pushing. Everything below this point is synchronous until the push,
  // so no second re-gate is needed before it.
  const fresh = getGoal(db, sessionKey);
  if (!fresh || fresh.status !== "active" || fresh.revision !== g.revision) {
    return {
      action: "skipped",
      reason: `goal ${fresh?.status ?? "deleted"} while judging — no push, no turn charged`,
      verdict: judge.verdict,
    };
  }
  g = fresh;
  return applyTurnVerdict(db, g, agentId, response, judge, cfg, pushOpts);
}

/**
 * Apply a turn-end verdict to the goal row (the post-judge half of
 * evaluateTurnEnd, extracted so the reflector path applies verdicts
 * through exactly the same code): transport-failure accounting, wait /
 * blocked / done transitions, parse-failure and stall limits, the turn
 * budget, and the continuation push. `g` must be the fresh registry row;
 * the caller owns gating (status / revision / pending-eval checks).
 */
export async function applyTurnVerdict(
  db: DatabaseSync,
  g: GoalRow,
  agentId: string,
  response: string,
  judge: TurnJudgeResult,
  cfg: GoalConfig,
  pushOpts: PushOptions,
): Promise<TurnEndDecision> {
  const sessionKey = g.sessionKey;
  if (judge.transportFailed) {
    // The judge being unreachable says nothing about the goal — but unlike
    // Hermes (which never pauses), after N consecutive outages we pause and
    // surface it as a blocker (bug-3 fix). Never run an unaudited goal forever.
    g.consecutiveTransportFailures += 1;
    g.turnsUsed = Math.max(0, g.turnsUsed - 1); // the turn is not charged to the goal
    g.lastVerdict = "judge_unavailable";
    g.lastReason = judge.reason;
    saveGoal(db, g);
    if (g.consecutiveTransportFailures >= cfg.maxJudgeOutages) {
      g.status = "paused";
      g.lastReason = `goal judge unreachable ${g.consecutiveTransportFailures} turns in a row (${judge.reason}) — goal paused, not running unaudited`;
      saveGoal(db, g);
      return { action: "paused", reason: g.lastReason, verdict: "judge_unavailable" };
    }
    return { action: "continued_no_push", reason: `judge unavailable (${g.consecutiveTransportFailures}x); no push without a verdict`, verdict: "judge_unavailable" };
  }
  g.consecutiveTransportFailures = 0;
  g.lastVerdict = judge.verdict;
  g.lastReason = judge.reason;
  g.consecutiveParseFailures = judge.parseFailed ? g.consecutiveParseFailures + 1 : 0;

  if (judge.verdict === "wait") {
    const secs = judge.waitForSeconds && judge.waitForSeconds > 0 ? judge.waitForSeconds : 600;
    g.status = "waiting";
    g.waitingOn = "seconds";
    g.waitingUntil = Date.now() + secs * 1000;
    g.waitingReason = judge.reason || `waiting ${secs}s`;
    saveGoal(db, g);
    return { action: "waiting", reason: g.lastReason, verdict: "wait" };
  }

  if (judge.verdict === "blocked") {
    const blocker = judge.blocker || "unknown";
    if (blocker === "transient") {
      // Transient blocks are retried: continue (fall through to the push).
    } else if (blocker === "human_only" && judge.humanCategory === "reversible_choice") {
      // A reversible choice is the agent's to make: decide, note, proceed.
      if (judge.humanDecision) {
        g.pendingHumanDecisions = [...new Set([...g.pendingHumanDecisions, judge.humanDecision])];
      }
      // Fall through to the push, with the question appended to the prompt.
    } else {
      // Human-only (money / credentials / irreversible) or unknown: pause.
      g.status = "paused";
      if (judge.humanDecision) {
        g.pendingHumanDecisions = [...new Set([...g.pendingHumanDecisions, judge.humanDecision])];
      }
      saveGoal(db, g);
      return { action: "paused", reason: `judged unachievable: ${judge.reason}`, verdict: "blocked" };
    }
  }

  if (judge.verdict === "done") {
    g.status = "done";
    saveGoal(db, g);
    return { action: "done", reason: judge.reason, verdict: "done" };
  }

  if (g.consecutiveParseFailures >= cfg.maxParseFailures) {
    g.status = "paused";
    saveGoal(db, g);
    return { action: "paused", reason: `judge model returned unparseable output ${g.consecutiveParseFailures} turns in a row`, verdict: judge.verdict };
  }

  // Stall check: N judged turns in a row whose reply repeats the previous one.
  const snippet = normalizeSnippet(response);
  const same = Boolean(g.lastResponseSnippet) && responseSimilarity(g.lastResponseSnippet, snippet) >= 0.85;
  g.consecutiveStalled = same ? g.consecutiveStalled + 1 : 0;
  g.lastResponseSnippet = snippet;
  if (g.consecutiveStalled >= cfg.maxStalledTurns) {
    g.status = "paused";
    saveGoal(db, g);
    return { action: "paused", reason: `no progress for ${g.consecutiveStalled} turns in a row`, verdict: judge.verdict };
  }

  // Turn budget.
  if (g.turnsUsed >= g.maxTurns) {
    g.status = "paused";
    saveGoal(db, g);
    return { action: "paused", reason: `turn budget exhausted (${g.turnsUsed}/${g.maxTurns})`, verdict: judge.verdict };
  }

  // Push: the goal is not reached, the agent should keep going. The push
  // IS the wake — a continuation prompt into the idle session.
  g.turnsUsed += 1;
  saveGoal(db, g);
  const prompt = buildContinuationPrompt({
    goal: g.goal,
    acceptanceCriteria: g.acceptanceCriteria,
    verification: g.verification,
    subgoals: g.subgoals,
    pendingHumanDecisions: g.pendingHumanDecisions,
  });
  if (cfg.dryRun) {
    return { action: "pushed", reason: `DRY RUN — would push (${judge.reason})`, verdict: judge.verdict };
  }
  const pushed = await pushContinuation(agentId, sessionKey, prompt, pushOpts);
  if (!pushed.ok) {
    return { action: "push_failed", reason: `push failed: ${pushed.detail}`, verdict: judge.verdict };
  }
  return { action: "pushed", reason: judge.reason, verdict: judge.verdict };
}
