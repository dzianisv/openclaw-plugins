/**
 * goal — the goal plugin for OpenClaw.
 *
 * A tool + a per-session registry + a Judge. The agent declares its own
 * session goal (goal tool, create) — that declaration IS the inference.
 * The registry stores it per session, keyed to the session KEY (stable,
 * survives compaction). The Judge runs at EVERY turn-end (agent goals
 * included — the Hermes bug-2 fix): if the goal is not reached, the plugin
 * PUSHES a continuation prompt into the idle session via agentTurn. The
 * push IS the wake. No timer, no hourly poll. Reactive, event-driven.
 *
 * Pieces:
 *   - `goal` tool (factory form, so each call is bound to the calling
 *     session's sessionKey/agentId).
 *   - `agent_end` hook: turn-end Judge + push / pause / done.
 *
 * Grading (2026-11-19 rework): a standing reflector session per agent
 * (`agent:<agentId>:goal-reflect`) grades turn-ends and validates
 * wait/complete requests — the agent cannot park or close its own goal;
 * its requests are recorded as pending and the status flips only when
 * the plugin applies the reflector's approving verdict. Pushes and
 * reflector dispatch run in-process via
 * `api.session.workflow.scheduleSessionTurn` (gateway Cron owns the
 * turns). The one-shot Judge (`openclaw capability model run` via CLI)
 * remains as the verdict-timeout fallback and for reflector-off mode;
 * the CLI agentTurn push remains behind pushRoute="cli".
 *
 * Handlers never throw: a plugin error must never break an agent run.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getGoal, listGoals, listGoalsForAgent, openRegistry, saveGoal,
  type GoalRow, type ReflectorVerdict,
} from "./registry.js";
import {
  evaluateTurnEnd, applyTurnVerdict, applyWaitRequest, addGoalEntry,
  setUserGoal, DEFAULT_CONFIG, type GoalConfig, type TurnJudgeResult,
} from "./goal.js";
import { PerSessionQueue } from "./turn-end-queue.js";
import {
  allLinkedTerminal,
  buildNudgePrompt,
  checkLinkedWork,
  detectBlockerClaim,
} from "./nudge.js";
import { judgeGoal, type JudgeOptions } from "./judge.js";
import { pushContinuation, type PushOptions, type ScheduleTurnFn } from "./push.js";
import {
  reflectorSessionKey, isReflectorSession, buildReflectorPrompt, parseReflectorVerdict,
} from "./reflector.js";

interface PluginConfig {
  judgeModel?: string;
  judgeFallbackModels?: string[];
  judgeTimeoutMs?: number;
  maxStalledTurns?: number;
  maxJudgeOutages?: number;
  maxParseFailures?: number;
  defaultMaxTurns?: number;
  enabledAgents?: string[];
  cliPath?: string;
  pushTimeoutSeconds?: number;
  nudgeEnabled?: boolean;
  nudgeIntervalMinutes?: number;
  nudgeInitialDelaySeconds?: number;
  reflectorEnabled?: boolean;
  pushRoute?: string;
  verdictTimeoutSeconds?: number;
  dbPath?: string;
  dryRun?: boolean;
}

type LogFn = (message: string) => void;

function readField(obj: unknown, ...names: string[]): unknown {
  if (typeof obj !== "object" || obj === null) return undefined;
  for (const name of names) {
    const value = (obj as Record<string, unknown>)[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** Extract the last assistant text from a run's messages (agent_end event). */
function extractLastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | null;
    if (!m || typeof m !== "object") continue;
    const role = m.role ?? m.type;
    if (role !== "assistant") continue;
    const content = m.content;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (typeof block === "string") parts.push(block);
        else if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (typeof b.text === "string") parts.push(b.text);
          else if (typeof b.content === "string") parts.push(b.content);
        }
      }
      const text = parts.join("\n").trim();
      if (text) return text;
    }
  }
  return "";
}

function resolveStateDir(): string {
  const env = process.env.OPENCLAW_STATE_DIR?.trim();
  if (env) return env;
  return join(homedir(), ".openclaw", "state");
}

export default definePluginEntry({
  id: "goal",
  name: "Goal",
  description:
    "Per-session goal ownership: the agent declares its goal, a judge audits it at every turn-end, and an unreached goal pushes a continuation prompt into the idle session.",
  register(api) {
    const log: LogFn = (message) => {
      const logger = (api as unknown as { logger?: { info?: (msg: string) => void } }).logger;
      if (logger?.info) {
        try { logger.info(`[goal] ${message}`); } catch { console.log(`[goal] ${message}`); }
      } else {
        console.log(`[goal] ${message}`);
      }
    };

    const rawConfig = (api as unknown as { pluginConfig?: unknown }).pluginConfig ?? {};
    const pc = rawConfig as PluginConfig;
    const cfg: GoalConfig = {
      judgeModel: typeof pc.judgeModel === "string" && pc.judgeModel.trim() ? pc.judgeModel.trim() : DEFAULT_CONFIG.judgeModel,
      judgeFallbackModels: Array.isArray(pc.judgeFallbackModels)
        ? pc.judgeFallbackModels.filter((m): m is string => typeof m === "string" && !!m.trim()).map((m) => m.trim())
        : DEFAULT_CONFIG.judgeFallbackModels,
      judgeTimeoutMs: typeof pc.judgeTimeoutMs === "number" && pc.judgeTimeoutMs > 0 ? pc.judgeTimeoutMs : DEFAULT_CONFIG.judgeTimeoutMs,
      maxStalledTurns: typeof pc.maxStalledTurns === "number" && pc.maxStalledTurns > 0 ? pc.maxStalledTurns : DEFAULT_CONFIG.maxStalledTurns,
      maxJudgeOutages: typeof pc.maxJudgeOutages === "number" && pc.maxJudgeOutages > 0 ? pc.maxJudgeOutages : DEFAULT_CONFIG.maxJudgeOutages,
      maxParseFailures: typeof pc.maxParseFailures === "number" && pc.maxParseFailures > 0 ? pc.maxParseFailures : DEFAULT_CONFIG.maxParseFailures,
      defaultMaxTurns: typeof pc.defaultMaxTurns === "number" && pc.defaultMaxTurns > 0 ? pc.defaultMaxTurns : DEFAULT_CONFIG.defaultMaxTurns,
      cliPath: typeof pc.cliPath === "string" && pc.cliPath.trim() ? pc.cliPath.trim() : DEFAULT_CONFIG.cliPath,
      pushTimeoutSeconds: typeof pc.pushTimeoutSeconds === "number" && pc.pushTimeoutSeconds > 0 ? pc.pushTimeoutSeconds : DEFAULT_CONFIG.pushTimeoutSeconds,
      dryRun: pc.dryRun === true,
      nudgeEnabled: pc.nudgeEnabled !== false,
      nudgeIntervalMinutes: typeof pc.nudgeIntervalMinutes === "number" && pc.nudgeIntervalMinutes > 0 ? pc.nudgeIntervalMinutes : DEFAULT_CONFIG.nudgeIntervalMinutes,
      nudgeInitialDelaySeconds: typeof pc.nudgeInitialDelaySeconds === "number" && pc.nudgeInitialDelaySeconds >= 0 ? pc.nudgeInitialDelaySeconds : DEFAULT_CONFIG.nudgeInitialDelaySeconds,
      reflectorEnabled: pc.reflectorEnabled !== false,
      pushRoute: pc.pushRoute === "cli" ? "cli" : "api",
      verdictTimeoutSeconds: typeof pc.verdictTimeoutSeconds === "number" && pc.verdictTimeoutSeconds > 0 ? pc.verdictTimeoutSeconds : DEFAULT_CONFIG.verdictTimeoutSeconds,
    };
    const enabledAgents = new Set(
      (Array.isArray(pc.enabledAgents) ? pc.enabledAgents : []).filter((a): a is string => typeof a === "string" && !!a.trim()),
    );
    const dbPath =
      typeof pc.dbPath === "string" && pc.dbPath.trim()
        ? pc.dbPath.trim()
        : join(resolveStateDir(), "goal.db");

    let db: DatabaseSync | null = null;
    const getDb = (): DatabaseSync => {
      if (!db) db = openRegistry(dbPath);
      return db;
    };

    log(`started (judgeModel=${cfg.judgeModel}, judgeFallbacks=[${cfg.judgeFallbackModels.length > 0 ? cfg.judgeFallbackModels.join(",") : DEFAULT_CONFIG.judgeModel}], db=${dbPath}, dryRun=${cfg.dryRun}, enabledAgents=${enabledAgents.size ? [...enabledAgents].join(",") : "all"})`);

    // API probe + wiring (2026-11-19): the in-process rework (API pushes +
    // the reflector session) depends on api.session.workflow.scheduleSessionTurn
    // being reachable from THIS plugin's registration api object. Feature-
    // detect and log it at every start; the rest of the rework keys off
    // this result. If it is ever NOT reachable, pushes fall back to the
    // CLI route and the reflector is disabled (both logged, never silent).
    const workflowApi = (api as unknown as {
      session?: {
        workflow?: {
          scheduleSessionTurn?: (params: Record<string, unknown>) => Promise<unknown>;
          enqueueNextTurnInjection?: unknown;
          steerActiveRun?: unknown;
        };
      };
    }).session?.workflow;
    const scheduleSessionTurnRaw = workflowApi?.scheduleSessionTurn;
    const workflowReachable = typeof scheduleSessionTurnRaw === "function";
    log(
      `workflow api probe: session.workflow=${workflowApi ? "present" : "ABSENT"}, ` +
      `scheduleSessionTurn=${workflowReachable ? "REACHABLE" : "NOT REACHABLE"}, ` +
      `enqueueNextTurnInjection=${typeof workflowApi?.enqueueNextTurnInjection === "function" ? "function" : "missing"}, ` +
      `steerActiveRun=${typeof workflowApi?.steerActiveRun === "function" ? "function" : "missing"}`,
    );
    const scheduleTurn: ScheduleTurnFn | undefined = workflowReachable
      ? async ({ agentId, sessionKey, message }) => {
          // Retry on a null handle: core silently refuses the call when
          // this registration's lifecycle authority is momentarily not the
          // committing generation (the gateway registers this plugin
          // several times; authority flips between them during startup
          // and registry rebuilds). Observed 2026-11-19: first attempt
          // returned no handle, a retry ~5s later succeeded.
          let lastDetail = "scheduleSessionTurn returned no job handle";
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const handle = await scheduleSessionTurnRaw!.call(workflowApi, {
                sessionKey,
                message,
                agentId: agentId || undefined,
                delayMs: 0,
                tag: "goal-plugin",
                deliveryMode: "announce", // core 2026.11.2: "none" breaks cron turns in channel-bound sessions (plugin delivery capability is no longer active); announce is the supervisor-proven mode
                name: "goal-plugin",
              });
              if (handle) return { ok: true, detail: "turn scheduled via api.session.workflow" };
            } catch (err) {
              lastDetail = `scheduleSessionTurn threw: ${err instanceof Error ? err.message : String(err)}`;
            }
            if (attempt < 3) await new Promise((r) => setTimeout(r, 5_000));
          }
          return { ok: false, detail: lastDetail };
        }
      : undefined;
    // Effective modes: the configured route/mode, degraded only when the
    // API is missing (logged above and again here — never silent).
    const pushRoute: "api" | "cli" = cfg.pushRoute === "api" && workflowReachable ? "api" : "cli";
    if (cfg.pushRoute === "api" && !workflowReachable) {
      log("workflow api unavailable: pushes fall back to the CLI route");
    }
    const reflectorActive = cfg.reflectorEnabled && workflowReachable;
    if (cfg.reflectorEnabled && !workflowReachable) {
      log("workflow api unavailable: reflector disabled — one-shot judge path remains in effect");
    }
    log(`routes: push=${pushRoute}, reflector=${reflectorActive ? "on" : "off"}, verdictTimeout=${cfg.verdictTimeoutSeconds}s`);
    const makePushOpts = (): PushOptions => ({
      cliPath: cfg.cliPath,
      timeoutSeconds: cfg.pushTimeoutSeconds,
      route: pushRoute,
      scheduleTurn,
    });

    // NOTE: the `goal` tool is NOT registered here. A tool registered at
    // runtime with api.registerTool inside a definePluginEntry is never
    // exposed to agents — the runtime only builds agents' tool lists from
    // tools declared via defineToolPlugin (the metadata attached to the
    // entry). The `goal` tool lives in the sibling `goal-tool` plugin
    // (defineToolPlugin). This plugin only runs the turn-end hook.

    // ---- periodic driver + worker-end resume ----
    // The turn-end judge only fires when the goal's own session ends a
    // turn. A goal parked in waiting/subagents — or an idle session —
    // never produces that event, so the loop stalls silently (the
    // 2026-11-18 freeze: a goal sat waiting/subagents for a day while
    // its workers finished). This driver is the plugin-level push:
    // every nudgeIntervalMinutes it scans ALL goals in the registry
    // (any agent, any session) and pushes each non-complete goal's
    // owning session with the current state. If a goal is parked on
    // subagents and every linked item is terminal, the driver first
    // resumes it (same state transition as the plugin's resume action),
    // then pushes. Paused goals are left alone — a human paused them.
    const driverPushOpts: PushOptions = makePushOpts();
    // This gateway registers the plugin more than once in the same
    // process, so the driver's guards live on globalThis — shared across
    // registrations. Without this, each registration would run its own
    // scan and push the same goal once per registration.
    const driverLocks = ((globalThis as unknown as {
      __goalDriverLocks?: { inFlight: Set<string>; scanning: boolean };
    }).__goalDriverLocks ??= { inFlight: new Set<string>(), scanning: false });
    const nudgeInFlight = driverLocks.inFlight;

    const resumeGoal = (goal: GoalRow, reason = "Resumed by the goal driver: the waited-on linked work is terminal."): GoalRow => {
      const resumed: GoalRow = {
        ...goal,
        status: "active",
        waitingOn: "",
        waitingReason: "",
        waitingUntil: 0,
        lastReason: reason,
        updatedAt: Date.now(),
      };
      saveGoal(getDb(), resumed);
      return resumed;
    };

    const nudgeGoal = async (goal: GoalRow, mode: "periodic" | "worker-ended"): Promise<void> => {
      if (nudgeInFlight.has(goal.sessionKey)) return;
      // A reflector evaluation is in flight for this goal — its verdict
      // (or the timeout fallback) drives the next step; a nudge now would
      // double-push the session.
      if (goal.pendingEval) return;
      nudgeInFlight.add(goal.sessionKey);
      try {
        const linked = await checkLinkedWork(goal.linkedTaskIds, 30_000);
        const parkedOnSubagents = goal.status === "waiting" && goal.waitingOn === "subagents";
        const terminal = allLinkedTerminal(linked);
        // A timed (seconds) wait is a promise the agent made to itself.
        // Unexpired: respect it — do not push into the wait. Expired: the
        // wait is over; resume mechanically here, because the turn-end
        // path only clears an expired wait when the session ends a turn,
        // and a session jammed by long runs may not end one for hours
        // (2026-11-19 audit: goal sat waiting/seconds 2h15m past expiry).
        const waitingSeconds = goal.status === "waiting" && goal.waitingOn === "seconds";
        const waitExpired = waitingSeconds && goal.waitingUntil > 0 && Date.now() >= goal.waitingUntil;
        if (waitingSeconds && !waitExpired) return;
        if (mode === "worker-ended" && !terminal && !waitExpired) return;
        let current = goal;
        let resumed = false;
        if (parkedOnSubagents && terminal) {
          current = resumeGoal(goal);
          resumed = true;
        } else if (waitExpired) {
          current = resumeGoal(goal, "Resumed by the goal driver: the timed (seconds) wait expired.");
          resumed = true;
        }
        if (cfg.dryRun) {
          log(`driver: [dry-run] would nudge ${goal.sessionKey} (mode=${mode}, status=${current.status}, resumed=${resumed})`);
          return;
        }
        const prompt = buildNudgePrompt(current, linked, {
          wake: resumed ? "resumed" : mode === "worker-ended" ? "linked-work-terminal" : "periodic",
          rejectedClaim: detectBlockerClaim(current.lastResponseSnippet) || undefined,
        });
        const result = await pushContinuation(current.agentId, current.sessionKey, prompt, driverPushOpts);
        if (result.ok) {
          log(`driver: nudged ${goal.sessionKey} (mode=${mode}, status=${current.status}, turns=${current.turnsUsed}/${current.maxTurns})`);
        } else {
          log(`driver: nudge push FAILED for ${goal.sessionKey}: ${result.detail}`);
        }
      } catch (err) {
        log(`driver: nudge error for ${goal.sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        nudgeInFlight.delete(goal.sessionKey);
      }
    };

    const scanAllGoals = async (trigger: string): Promise<void> => {
      if (driverLocks.scanning) return;
      driverLocks.scanning = true;
      try {
        const goals = listGoals(getDb());
        for (const goal of goals) {
          if (goal.status === "done" || goal.status === "cancelled") continue;
          if (enabledAgents.size > 0 && !enabledAgents.has(goal.agentId)) continue;
          if (goal.sessionKey.startsWith("cron_")) continue;
          if (isReflectorSession(goal.sessionKey)) continue;
          if (goal.status === "paused") {
            log(`driver: skipping paused goal in ${goal.sessionKey} (${trigger}) — pause cause: ${(goal.lastReason || "unknown").slice(0, 160)}`);
            continue;
          }
          await nudgeGoal(goal, "periodic");
        }
      } catch {
        // The driver must never break the gateway.
      } finally {
        driverLocks.scanning = false;
      }
    };

    // Called from the turn-end hook: a run just ended in
    // `workerSessionKey`. If that run belongs to an agent whose goal is
    // parked on subagents, give the driver a chance to resume + push the
    // goal's own main session (it acts only when the linked work is
    // terminal).
    const maybeResumeOnWorkerEnd = async (workerSessionKey: string, workerAgentId: string): Promise<void> => {
      try {
        if (!cfg.nudgeEnabled || !workerAgentId) return;
        const siblings = listGoals(getDb()).filter(
          (g) =>
            g.agentId === workerAgentId &&
            g.sessionKey !== workerSessionKey &&
            g.status === "waiting" &&
            g.waitingOn === "subagents",
        );
        for (const goal of siblings) {
          await nudgeGoal(goal, "worker-ended");
        }
      } catch {
        // Observation must never break a run.
      }
    };

    if (cfg.nudgeEnabled) {
      const intervalMs = Math.max(1, cfg.nudgeIntervalMinutes) * 60_000;
      const initialDelayMs = Math.max(0, cfg.nudgeInitialDelaySeconds) * 1000;
      const driverTimer = setInterval(() => {
        void scanAllGoals("periodic");
      }, intervalMs);
      (driverTimer as unknown as { unref?: () => void }).unref?.();
      const initialTimer = setTimeout(() => {
        void scanAllGoals("initial");
      }, initialDelayMs);
      (initialTimer as unknown as { unref?: () => void }).unref?.();
      log(`driver: nudge enabled (every ${cfg.nudgeIntervalMinutes} min, first scan in ${cfg.nudgeInitialDelaySeconds}s)`);
    }

    // ---- reflector: dispatch evaluations, apply verdicts, fall back ----
    // The reflector is a standing session per agent
    // (agent:<agentId>:goal-reflect). The plugin sends it evaluations via
    // scheduleSessionTurn; the reflector rules with the goal tool's
    // verdict action; the plugin applies the verdict when the reflector's
    // turn ends. Status transitions happen ONLY in applyReflectorOutcome
    // (and the legacy paths when the reflector is off) — never in the
    // working agent's own tool call. State shared across this process's
    // plugin registrations lives on globalThis, like the driver locks.
    const reflectorState = ((globalThis as unknown as {
      __goalReflectorState?: { seeded: Set<string>; dispatching: Set<string>; sweeping: boolean; sweeperStarted: boolean };
    }).__goalReflectorState ??= { seeded: new Set<string>(), dispatching: new Set<string>(), sweeping: false, sweeperStarted: false });

    const judgeOptsFor = (agentId: string): JudgeOptions => ({
      agentId,
      judgeModel: cfg.judgeModel,
      // A configured judge model that 429s must never strand a verdict:
      // with no explicit fallback list, the built-in default judge model
      // (Super-VL free) is always second in line. judgeGoal de-duplicates.
      fallbackModels: cfg.judgeFallbackModels.length > 0 ? cfg.judgeFallbackModels : [DEFAULT_CONFIG.judgeModel],
      cliPath: cfg.cliPath,
      timeoutMs: cfg.judgeTimeoutMs,
    });

    /** Send an evaluation of `goal` into the agent's reflector session. */
    const dispatchEval = async (
      goal: GoalRow,
      kind: "turn-end" | "wait" | "complete",
      payload: { response?: string; claim?: string },
    ): Promise<boolean> => {
      if (!reflectorActive || !scheduleTurn) return false;
      if (reflectorState.dispatching.has(goal.sessionKey)) return false;
      reflectorState.dispatching.add(goal.sessionKey);
      try {
        const linked = await checkLinkedWork(goal.linkedTaskIds, 30_000);
        const evalId = randomUUID();
        const seeded = !reflectorState.seeded.has(goal.agentId);
        const prompt = buildReflectorPrompt({
          evalId,
          targetSessionKey: goal.sessionKey,
          goal,
          kind,
          claim: payload.claim,
          response: payload.response,
          linkedStates: linked,
          seeded,
        });
        const withEval: GoalRow = {
          ...goal,
          pendingEval: {
            evalId,
            kind,
            dispatchedAt: 0,
            queuedAt: Date.now(),
            response: (payload.response ?? payload.claim ?? "").slice(0, 4000),
          },
        };
        saveGoal(getDb(), withEval);
        const r = await scheduleTurn({
          agentId: goal.agentId,
          sessionKey: reflectorSessionKey(goal.agentId),
          message: prompt,
        });
        if (!r.ok) {
          // Keep the eval QUEUED on the row: this instance may be unable
          // to commit workflow side effects (core ties scheduleSessionTurn
          // to the committing registry generation, and the gateway
          // registers this plugin several times), while the pending
          // sweeper in the committing instance re-dispatches from the
          // row. Dropping the eval here silently downgraded turn-end
          // grading to the one-shot judge (observed 2026-11-19).
          log(`reflector: dispatch queued for ${goal.sessionKey} (kind=${kind}): ${r.detail}`);
          return false;
        }
        const curOk = getGoal(getDb(), goal.sessionKey);
        if (curOk?.pendingEval?.evalId === evalId) {
          curOk.pendingEval = { ...curOk.pendingEval, dispatchedAt: Date.now() };
          saveGoal(getDb(), curOk);
        }
        reflectorState.seeded.add(goal.agentId);
        log(`reflector: dispatched ${kind} eval ${evalId} for ${goal.sessionKey} -> ${reflectorSessionKey(goal.agentId)}`);
        return true;
      } catch (err) {
        log(`reflector: dispatch error for ${goal.sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      } finally {
        reflectorState.dispatching.delete(goal.sessionKey);
      }
    };

    /**
     * Apply a reflector outcome to a goal with a pending evaluation. This
     * is the ONLY place reflector verdicts change goal status: turn-end
     * verdicts go through applyTurnVerdict (the same code the one-shot
     * judge path uses); wait/complete requests flip only on approval,
     * and a denial is recorded on the row and pushed back into the
     * agent's own session. A null verdict (the reflector ended without
     * ruling) is treated as continue / deny — never done, never parked.
     */
    const applyReflectorOutcome = async (goalIn: GoalRow, verdict: ReflectorVerdict | null): Promise<void> => {
      const db = getDb();
      const goal = getGoal(db, goalIn.sessionKey);
      if (!goal?.pendingEval) return;
      const pending = goal.pendingEval;
      const kind = pending.kind;
      if (kind !== "turn-end" && !goal.pendingRequest) {
        // The request was already resolved by another path; just close
        // out the evaluation record.
        goal.pendingEval = null;
        saveGoal(db, goal);
        return;
      }
      const v: ReflectorVerdict = verdict ?? {
        verdict: "continue",
        reason: "reflector returned no verdict — treated as continue (never done, never parked)",
        at: Date.now(),
      };
      addGoalEntry(goal, `reflector verdict (${kind})`, `${v.verdict}${v.decision ? ` / ${v.decision}` : ""} — ${v.reason}`);
      if (kind === "turn-end") {
        goal.pendingEval = null;
        saveGoal(db, goal);
        if (goal.status !== "active") {
          log(`reflector: turn-end verdict for ${goal.sessionKey} not applied — goal is ${goal.status}`);
          return;
        }
        const judge: TurnJudgeResult = {
          verdict: v.verdict,
          reason: v.reason,
          parseFailed: false,
          transportFailed: false,
          blocker: v.blocker,
          humanCategory: v.humanCategory,
          humanDecision: v.humanDecision,
          waitForSeconds: v.waitForSeconds,
        };
        const decision = await applyTurnVerdict(db, goal, goal.agentId, pending.response, judge, cfg, makePushOpts());
        log(`reflector: turn-end verdict applied for ${goal.sessionKey}: ${decision.action} (verdict=${v.verdict}): ${v.reason}`);
        return;
      }
      // wait / complete requests.
      const req = goal.pendingRequest!;
      goal.pendingEval = null;
      goal.pendingRequest = null;
      const approved =
        kind === "complete"
          ? v.decision === "approve" || (v.decision === undefined && v.verdict === "done")
          : v.decision === "approve" || (v.decision === undefined && v.verdict === "wait");
      if (approved) {
        if (kind === "complete") {
          goal.status = "done";
          goal.lastVerdict = "done";
          goal.lastReason = v.reason;
          saveGoal(db, goal);
          log(`reflector: completion APPROVED for ${goal.sessionKey}: ${v.reason}`);
        } else {
          applyWaitRequest(goal, req);
          goal.lastVerdict = "wait";
          goal.lastReason = v.reason;
          saveGoal(db, goal);
          log(`reflector: wait APPROVED for ${goal.sessionKey} (on=${req.on}): ${v.reason}`);
        }
        return;
      }
      // Denied: the goal stays active; the denial is recorded on the row
      // (nudges quote it) and pushed back into the agent's own session.
      goal.lastDenial = `${kind} request denied by the reflector: ${v.reason}`;
      if (kind === "complete") {
        goal.lastVerdict = v.verdict;
        goal.lastReason = v.reason;
      }
      saveGoal(db, goal);
      log(`reflector: ${kind} request DENIED for ${goal.sessionKey}: ${v.reason}`);
      if (!cfg.dryRun) {
        const text =
          `[goal plugin] Your ${kind} request was DENIED by the reflector. ${v.reason}\n` +
          `The goal stays active. Act on the evidence above in this turn — do not re-ask the same ${kind} claim.`;
        const pushed = await pushContinuation(goal.agentId, goal.sessionKey, text, makePushOpts());
        if (!pushed.ok) log(`reflector: denial push FAILED for ${goal.sessionKey}: ${pushed.detail}`);
      }
    };

    /** Resolve a pending wait/complete request with the one-shot judge (reflector off / timed out). */
    const resolveRequestWithJudge = async (goalIn: GoalRow): Promise<void> => {
      const db = getDb();
      let goal = getGoal(db, goalIn.sessionKey);
      if (!goal?.pendingRequest || goal.pendingEval) return;
      // Defer to the reflector while the request is fresh: dispatch can
      // fail in a plugin instance whose registry generation cannot commit
      // workflow side effects, while another instance's sweeper dispatches
      // successfully seconds later. An immediate fallback races that
      // dispatch — and once overwrote a live reflector eval (2026-11-19).
      // The sweeper re-enters here after the grace window.
      if (reflectorActive && Date.now() - (goal.pendingRequest.requestedAt || 0) < 90_000) return;
      const req = goal.pendingRequest;
      // Mechanical evidence gate (static evidence first, then the judge):
      // a wait/complete request can never be approved while linked work is
      // not terminal. The one-shot judge receives no live evidence, so
      // without this gate it approves parks against open issues on claim
      // text alone (observed 2026-11-19: wait approved while
      // VibeTechnologies/AgentPod#6225 was still open).
      if (goal.linkedTaskIds.length > 0) {
        const linked = await checkLinkedWork(goal.linkedTaskIds, 30_000);
        if (!allLinkedTerminal(linked)) {
          const openItems = linked
            .filter((i) => i.state !== "closed")
            .map((i) => `${i.id} (${i.state})`)
            .join(", ");
          const synthetic: ReflectorVerdict = {
            verdict: "continue",
            reason: `validation fallback (mechanical evidence): linked work is not terminal - ${openItems}. A ${req.kind} request cannot be approved while linked work is open.`,
            decision: "deny",
            at: Date.now(),
          };
          goal.pendingEval = {
            evalId: `fallback-${Date.now()}`,
            kind: req.kind,
            dispatchedAt: Date.now(),
            response: req.reason,
            verdict: synthetic,
          };
          saveGoal(db, goal);
          await applyReflectorOutcome(goal, synthetic);
          return;
        }
      }
      const judge = await judgeGoal(
        {
          goal: goal.goal,
          response: req.reason,
          acceptanceCriteria: goal.acceptanceCriteria,
          verification: goal.verification,
          userAsk: goal.userAsk,
          subgoals: goal.subgoals,
          evidence: req.kind === "complete" ? req.reason : undefined,
        },
        judgeOptsFor(goal.agentId),
      );
      // Race guard: while the judge ran, a reflector evaluation may have
      // been dispatched or the request may already be resolved. Never
      // overwrite a live reflector eval with the fallback verdict.
      const fresh = getGoal(db, goalIn.sessionKey);
      if (!fresh?.pendingRequest || (fresh.pendingEval && !String(fresh.pendingEval.evalId).startsWith("fallback-"))) return;
      goal = fresh;
      const synthetic: ReflectorVerdict = {
        verdict: judge.verdict,
        reason: `one-shot judge fallback: ${judge.reason}`,

        decision:
          req.kind === "complete"
            ? judge.verdict === "done"
              ? "approve"
              : "deny"
            : judge.verdict === "wait"
              ? "approve"
              : "deny",
        blocker: judge.blocker,
        humanCategory: judge.humanCategory,
        humanDecision: judge.humanDecision,
        waitForSeconds: judge.waitForSeconds,
        at: Date.now(),
      };
      if (judge.transportFailed) {
        // The fallback itself is unreachable: deny the state change (the
        // goal stays active and driven) rather than stranding the request.
        synthetic.decision = "deny";
        synthetic.reason = `validation fallback unavailable (judge transport failed: ${judge.reason}) — request denied, goal stays active`;
      }
      goal.pendingEval = {
        evalId: `fallback-${Date.now()}`,
        kind: req.kind,
        dispatchedAt: Date.now(),
        response: req.reason,
        verdict: synthetic,
      };
      saveGoal(db, goal);
      await applyReflectorOutcome(goal, synthetic);
    };

    /** Resolve a timed-out turn-end evaluation with the synchronous judge path. */
    const resolveTurnEndWithJudge = async (goalIn: GoalRow): Promise<void> => {
      const db = getDb();
      const goal = getGoal(db, goalIn.sessionKey);
      if (!goal?.pendingEval || goal.pendingEval.kind !== "turn-end") return;
      const response = goal.pendingEval.response;
      goal.pendingEval = null;
      saveGoal(db, goal);
      const decision = await evaluateTurnEnd(db, goal.sessionKey, goal.agentId, response, cfg, judgeOptsFor(goal.agentId), makePushOpts());
      log(`reflector: turn-end fallback applied for ${goal.sessionKey}: ${decision.action} (${decision.reason})`);
    };

    /**
     * The pending sweeper: verdicts recorded but never applied (a missed
     * reflector agent_end), evaluations past the verdict timeout (one-shot
     * judge fallback), and requests that never got dispatched (a turn that
     * ended before the hook ran, a gateway restart mid-flight).
     */
    const sweepPendings = async (): Promise<void> => {
      if (reflectorState.sweeping) return;
      reflectorState.sweeping = true;
      try {
        const goals = listGoals(getDb());
        for (const goal of goals) {
          if (isReflectorSession(goal.sessionKey) || goal.sessionKey.startsWith("cron_")) continue;
          if (enabledAgents.size > 0 && !enabledAgents.has(goal.agentId)) continue;
          if (goal.pendingEval?.verdict) {
            await applyReflectorOutcome(goal, goal.pendingEval.verdict);
            continue;
          }
          if (goal.pendingEval && !goal.pendingEval.verdict && goal.pendingEval.dispatchedAt === 0) {
            // Queued by an instance that could not schedule it: dispatch
            // from here. If this instance cannot either, the eval stays
            // queued and the timeout below (from queuedAt) still bounds it.
            const pe = goal.pendingEval;
            const claim = getGoal(getDb(), goal.sessionKey)?.pendingRequest?.reason ?? pe.response;
            await dispatchEval(goal, pe.kind, pe.kind === "turn-end" ? { response: pe.response } : { claim });
            continue;
          }
          if (goal.pendingEval) {
            const ageMs = Date.now() - (goal.pendingEval.dispatchedAt || goal.pendingEval.queuedAt || Date.now());
            if (ageMs > cfg.verdictTimeoutSeconds * 1000) {
              log(`reflector: eval for ${goal.sessionKey} timed out after ${Math.round(ageMs / 1000)}s — one-shot judge fallback`);
              if (goal.pendingEval.kind === "turn-end") {
                await resolveTurnEndWithJudge(goal);
              } else {
                const cur = getGoal(getDb(), goal.sessionKey);
                if (cur?.pendingEval) {
                  cur.pendingEval = null;
                  saveGoal(getDb(), cur);
                }
                await resolveRequestWithJudge(goal);
              }
            }
            continue;
          }
          if (goal.pendingRequest && goal.status === "active") {
            const dispatched = reflectorActive
              ? await dispatchEval(goal, goal.pendingRequest.kind, { claim: goal.pendingRequest.reason })
              : false;
            if (!dispatched) await resolveRequestWithJudge(goal);
          }
        }
      } catch {
        // The sweeper must never break the gateway.
      } finally {
        reflectorState.sweeping = false;
      }
    };

    if (!reflectorState.sweeperStarted) {
      reflectorState.sweeperStarted = true;
      const sweeperTimer = setInterval(() => {
        void sweepPendings();
      }, 20_000);
      (sweeperTimer as unknown as { unref?: () => void }).unref?.();
    }

    /** A reflector session ended a turn: apply the verdicts it recorded for its agent's goals. */
    const handleReflectorEnd = async (reflectorKey: string, agentId: string, event: unknown): Promise<void> => {
      const goals = listGoalsForAgent(getDb(), agentId).filter(
        (g) => g.pendingEval && g.pendingEval.dispatchedAt > 0 && reflectorSessionKey(g.agentId) === reflectorKey,
      );
      if (goals.length === 0) return;
      const lastText = extractLastAssistantText(readField(event, "messages"));
      for (const goal of goals) {
        const verdict = goal.pendingEval?.verdict ?? parseReflectorVerdict(lastText);
        await applyReflectorOutcome(goal, verdict);
      }
    };

    // ---- turn-end: Judge the goal, push if not reached (the reactive wake) ----
    // W16: evaluations are serialized per session. agent_end can fire
    // several times a minute for one session, and each evaluation runs a
    // ~60s judge call; without this they overlap and a pause written by
    // one does not stop the others from pushing (and charging turns).
    // Different sessions still evaluate in parallel.
    const seenRuns = new Set<string>();
    const turnEndQueue = new PerSessionQueue();
    api.on("agent_end", (event, ctx) => {
      // Synchronous dedup + session-key read: two identical runIds firing
      // back-to-back must not both enter the queue.
      const runId = readField(ctx, "runId") ?? readField(event, "runId");
      const runKey = typeof runId === "string" && runId ? runId : "";
      if (runKey) {
        if (seenRuns.has(runKey)) return;
        seenRuns.add(runKey);
        if (seenRuns.size > 500) {
          const oldest = seenRuns.values().next().value;
          if (oldest) seenRuns.delete(oldest);
        }
      }
      const sessionKey =
        (readField(ctx, "sessionKey") as string | undefined) ??
        (readField(event, "sessionKey") as string | undefined) ??
        "";
      if (!sessionKey || sessionKey.startsWith("cron_")) return;
      // Fire-and-forget: the hook budget bounds the await, not the work.
      // The queue runs the evaluation in the background, one at a time
      // per session.
      turnEndQueue.run(sessionKey, async () => {
        try {
          const agentId =
            (readField(ctx, "agentId") as string | undefined) ??
            (readField(event, "agentId") as string | undefined) ??
            "";
          if (enabledAgents.size > 0 && agentId && !enabledAgents.has(agentId)) return;
          // Reflector sessions are graded by nobody: their turn-end is
          // where the verdicts they recorded get applied to the goals
          // they evaluated. They never own goals themselves.
          if (isReflectorSession(sessionKey)) {
            const reflectorAgent = agentId || sessionKey.split(":")[1] || "";
            if (reflectorAgent) await handleReflectorEnd(sessionKey, reflectorAgent, event);
            return;
          }
          // Re-read here (not at hook-fire time): an earlier queued
          // evaluation may have paused or parked the goal meanwhile.
          // Worker-end wake first: if this run was a worker/subagent
          // of an agent whose goal is parked on subagents and the
          // linked work just went terminal, the driver resumes the
          // goal and pushes its own main session.
          await maybeResumeOnWorkerEnd(sessionKey, agentId);
          const goal = getGoal(getDb(), sessionKey);
          if (!goal) return;
          // An evaluation is already in flight for this goal — the
          // reflector's verdict (or the timeout fallback) resolves it;
          // never dispatch a second one over it.
          if (goal.pendingEval) return;
          // A wait/complete request recorded during this turn takes
          // precedence over grading the turn: send it to the reflector
          // (or resolve it with the one-shot judge when the reflector
          // is off). The status flips only on an approving verdict.
          if (goal.pendingRequest && goal.status === "active") {
            const dispatched = reflectorActive
              ? await dispatchEval(goal, goal.pendingRequest.kind, { claim: goal.pendingRequest.reason })
              : false;
            if (!dispatched) await resolveRequestWithJudge(goal);
            return;
          }
          if (goal.status !== "active") return;
          const lastResponse = extractLastAssistantText(readField(event, "messages"));
          if (!lastResponse.trim()) return;
          if (reflectorActive) {
            await dispatchEval(goal, "turn-end", { response: lastResponse });
            // Dispatched — or queued on the row for the sweeper to
            // dispatch from a committing instance. Either way the
            // reflector path owns this evaluation exactly once; the
            // sweeper's verdict-timeout fallback grades it only if the
            // reflector never rules.
            return;
          }
          const decision = await evaluateTurnEnd(
            getDb(), sessionKey, agentId || goal.agentId, lastResponse, cfg,
            judgeOptsFor(agentId || goal.agentId), makePushOpts(),
          );
          log(
            `session ${sessionKey} agent ${agentId || goal.agentId}: turn-end ${decision.action} ` +
            `(verdict=${decision.verdict ?? "-"}): ${decision.reason}`,
          );
        } catch {
          // Observation must never break a run.
        }
      });
    });
  },
});

// Re-exported for the operator admin script (scripts/goal-admin.mjs).
export { setUserGoal, getGoal, saveGoal };
