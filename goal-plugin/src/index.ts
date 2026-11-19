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
 * The Judge is a separate one-shot model call via the `openclaw` CLI
 * (`capability model run`). The push is an agentTurn via the CLI.
 * Both follow the failover-compact pattern (talk to the gateway the same
 * way an operator would; the public plugin SDK exposes no in-process
 * equivalents).
 *
 * Handlers never throw: a plugin error must never break an agent run.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { getGoal, listGoals, openRegistry, saveGoal, type GoalRow } from "./registry.js";
import { evaluateTurnEnd, setUserGoal, DEFAULT_CONFIG, type GoalConfig } from "./goal.js";
import { PerSessionQueue } from "./turn-end-queue.js";
import {
  allLinkedTerminal,
  buildNudgePrompt,
  checkLinkedWork,
  detectBlockerClaim,
} from "./nudge.js";
import { type JudgeOptions } from "./judge.js";
import { pushContinuation, type PushOptions } from "./push.js";

interface PluginConfig {
  judgeModel?: string;
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

    log(`started (judgeModel=${cfg.judgeModel}, db=${dbPath}, dryRun=${cfg.dryRun}, enabledAgents=${enabledAgents.size ? [...enabledAgents].join(",") : "all"})`);

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
    const driverPushOpts: PushOptions = { cliPath: cfg.cliPath, timeoutSeconds: cfg.pushTimeoutSeconds };
    // This gateway registers the plugin more than once in the same
    // process, so the driver's guards live on globalThis — shared across
    // registrations. Without this, each registration would run its own
    // scan and push the same goal once per registration.
    const driverLocks = ((globalThis as unknown as {
      __goalDriverLocks?: { inFlight: Set<string>; scanning: boolean };
    }).__goalDriverLocks ??= { inFlight: new Set<string>(), scanning: false });
    const nudgeInFlight = driverLocks.inFlight;

    const resumeGoal = (goal: GoalRow): GoalRow => {
      const resumed: GoalRow = {
        ...goal,
        status: "active",
        waitingOn: "",
        waitingReason: "",
        waitingUntil: 0,
        lastReason: "Resumed by the goal driver: the waited-on linked work is terminal.",
        updatedAt: Date.now(),
      };
      saveGoal(getDb(), resumed);
      return resumed;
    };

    const nudgeGoal = async (goal: GoalRow, mode: "periodic" | "worker-ended"): Promise<void> => {
      if (nudgeInFlight.has(goal.sessionKey)) return;
      nudgeInFlight.add(goal.sessionKey);
      try {
        const linked = await checkLinkedWork(goal.linkedTaskIds, 30_000);
        const parkedOnSubagents = goal.status === "waiting" && goal.waitingOn === "subagents";
        const terminal = allLinkedTerminal(linked);
        if (mode === "worker-ended" && !terminal) return;
        let current = goal;
        let resumed = false;
        if (parkedOnSubagents && terminal) {
          current = resumeGoal(goal);
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
          // Re-read here (not at hook-fire time): an earlier queued
          // evaluation may have paused or parked the goal meanwhile.
          // Worker-end wake first: if this run was a worker/subagent
          // of an agent whose goal is parked on subagents and the
          // linked work just went terminal, the driver resumes the
          // goal and pushes its own main session.
          await maybeResumeOnWorkerEnd(sessionKey, agentId);
          const goal = getGoal(getDb(), sessionKey);
          if (!goal || goal.status !== "active") return;
          const lastResponse = extractLastAssistantText(readField(event, "messages"));
          if (!lastResponse.trim()) return;
          const judgeOpts: JudgeOptions = {
            agentId: agentId || goal.agentId,
            judgeModel: cfg.judgeModel,
            cliPath: cfg.cliPath,
            timeoutMs: cfg.judgeTimeoutMs,
          };
          const pushOpts: PushOptions = { cliPath: cfg.cliPath, timeoutSeconds: cfg.pushTimeoutSeconds };
          const decision = await evaluateTurnEnd(getDb(), sessionKey, agentId || goal.agentId, lastResponse, cfg, judgeOpts, pushOpts);
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
