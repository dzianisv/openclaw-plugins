/**
 * failover-compact — an OpenClaw plugin that compacts a session automatically
 * after a run fails over to a fallback model.
 *
 * The problem it solves: when the primary model dies (usage limit, outage),
 * OpenClaw falls back to another model, but the session prompt stays huge
 * (in our case ~230k tokens). The fallback then chokes on that prompt too,
 * every run fails the same way, and nothing ever shrinks the prompt —
 * because native auto-compaction only fires on context-overflow errors or
 * after a *successful* turn, and neither ever happens while the primary is
 * dead. This plugin closes that loop: a failed run that used a fallback
 * triggers a compaction, so the next run starts small.
 *
 * Hooks used (all in the OpenClaw 2026.11.2 hook catalog):
 *   - `model_call_ended` — observe each model call's provider/model/outcome.
 *   - `before_model_resolve` — observe which model a turn is about to use.
 *   - `agent_end` — observe run success/duration; the decision point.
 *
 * Failure signal (learned live 2026-11-13): `agent_end.success` is NOT a
 * reliable failure signal. A run that only produced an error reply
 * ("The AI service is having trouble.") still reports success, because the
 * run completed by delivering that reply. The true signal is the tracked
 * model calls: if any call to the primary failed, or any fallback call
 * failed, the run failed — regardless of what `agent_end.success` says.
 * The plugin therefore derives run failure from its own per-run call
 * record, and only uses `agent_end.success === false` as an additional
 * trigger.
 *
 * Compaction itself is requested through the gateway method
 * `sessions.compact` via the local `openclaw` CLI (see gateway.ts), because
 * the public plugin SDK exposes no in-process compaction call.
 *
 * Safety:
 *   - Compaction only fires on a *failed* run that actually touched a
 *     fallback (or saw the primary fail), only when the session is over the
 *     token threshold, and at most once per session per cooldown window.
 *   - Handlers never throw: a plugin error must never break an agent run.
 *   - Compaction runs through the session's configured compaction model
 *     (`agents.defaults.compaction.model`). Point that at a working model —
 *     if it is the dead primary, the compaction 429s like everything else.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { shouldCompact } from "./decision.js";
import { compactSession, getSessionInputTokens } from "./gateway.js";

const DEFAULT_PRIMARY_MODEL = "opencode-go/deepseek-v4.1-flash";
const DEFAULT_TOKEN_THRESHOLD = 100_000;
const DEFAULT_COOLDOWN_MS = 3_600_000; // 1h
const DEFAULT_CLI_PATH = "openclaw";
const LIST_TIMEOUT_MS = 30_000;
const COMPACT_TIMEOUT_MS = 600_000; // compaction is itself a model call; give it 10 min

interface PluginConfig {
  primaryModel?: string;
  fallbackModels?: string[];
  tokenThreshold?: number;
  cooldownMs?: number;
  dryRun?: boolean;
  cliPath?: string;
  enabledAgents?: string[];
}

interface RunModelUsage {
  sessionKey: string;
  agentId?: string;
  primaryFailed: boolean;
  fallbackUsed: boolean;
  fallbackFailed: boolean;
  /** Last few calls, for the audit log line. Bounded to 8 entries. */
  calls: Array<{ model: string | null; failed: boolean }>;
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

function readModelId(event: unknown): string | null {
  const direct = readField(event, "model", "modelId");
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const resolved = readField(event, "resolvedModel", "modelRef");
  if (typeof resolved === "string" && resolved.trim()) return resolved.trim();
  if (typeof resolved === "object" && resolved !== null) {
    const id = readField(resolved, "id", "model");
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return null;
}

function readCallFailed(event: unknown): boolean {
  const success = readField(event, "success");
  if (success === false) return true;
  const outcome = readField(event, "outcome", "status");
  if (typeof outcome === "string") {
    const normalized = outcome.toLowerCase();
    if (normalized === "error" || normalized === "failed" || normalized === "failure") return true;
  }
  return readField(event, "error") !== undefined;
}

function readRunFailed(event: unknown): boolean {
  const success = readField(event, "success");
  if (success === false) return true;
  if (readField(event, "error") !== undefined) return true;
  const isError = readField(event, "isError");
  return isError === true;
}

/** Walk a config object defensively; returns undefined when the path is absent. */
function readConfigPath(config: unknown, path: string[]): unknown {
  let current: unknown = config;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export default definePluginEntry({
  id: "failover-compact",
  name: "Failover Compact",
  description:
    "Compacts a session automatically after a run fails over to a fallback model.",
  register(api) {
    const log: LogFn = (message) => {
      const logger = (api as unknown as { logger?: { info?: (msg: string) => void } }).logger;
      if (logger?.info) {
        try {
          logger.info(`[failover-compact] ${message}`);
        } catch {
          console.log(`[failover-compact] ${message}`);
        }
      } else {
        console.log(`[failover-compact] ${message}`);
      }
    };

    const rawConfig = (api as unknown as { pluginConfig?: unknown }).pluginConfig ?? {};
    const cfg = rawConfig as PluginConfig;

    // Prefer the gateway's own primary/fallbacks when the runtime exposes them.
    let primaryModel = cfg.primaryModel?.trim() || DEFAULT_PRIMARY_MODEL;
    let fallbackModels: string[] = Array.isArray(cfg.fallbackModels)
      ? cfg.fallbackModels.filter((m): m is string => typeof m === "string" && !!m.trim())
      : [];
    try {
      const runtimeConfig = (api as unknown as {
        runtime?: { config?: { current?: () => unknown } };
      }).runtime?.config?.current?.();
      const configuredPrimary = readConfigPath(runtimeConfig, [
        "agents",
        "defaults",
        "model",
        "primary",
      ]);
      if (typeof configuredPrimary === "string" && configuredPrimary.trim()) {
        primaryModel = configuredPrimary.trim();
      }
      const configuredFallbacks = readConfigPath(runtimeConfig, [
        "agents",
        "defaults",
        "model",
        "fallbacks",
      ]);
      if (Array.isArray(configuredFallbacks)) {
        fallbackModels = configuredFallbacks.filter(
          (m): m is string => typeof m === "string" && !!m.trim(),
        );
      }
    } catch {
      // Runtime config is best-effort; plugin config and defaults still apply.
    }

    const tokenThreshold =
      typeof cfg.tokenThreshold === "number" && cfg.tokenThreshold > 0
        ? cfg.tokenThreshold
        : DEFAULT_TOKEN_THRESHOLD;
    const cooldownMs =
      typeof cfg.cooldownMs === "number" && cfg.cooldownMs >= 0 ? cfg.cooldownMs : DEFAULT_COOLDOWN_MS;
    const dryRun = cfg.dryRun === true;
    const cliPath = cfg.cliPath?.trim() || DEFAULT_CLI_PATH;
    const enabledAgents = new Set(
      (cfg.enabledAgents ?? []).filter((a) => typeof a === "string" && !!a.trim()),
    );

    const runs = new Map<string, RunModelUsage>();
    const lastCompactAt = new Map<string, number>();
    const sizeCache = new Map<string, { tokens: number | null; at: number }>();

    log(
      `started (primary=${primaryModel}, fallbacks=[${fallbackModels.join(", ")}], ` +
        `threshold=${tokenThreshold}, cooldownMs=${cooldownMs}, dryRun=${dryRun})`,
    );

    const isFallbackModel = (modelId: string | null): boolean =>
      modelId !== null && modelId !== primaryModel && fallbackModels.includes(modelId);
    const isPrimaryModel = (modelId: string | null): boolean =>
      modelId !== null && modelId === primaryModel;

    const getRunKey = (ctx: unknown, event: unknown): string | null => {
      const runId = readField(ctx, "runId") ?? readField(event, "runId");
      return typeof runId === "string" && runId ? runId : null;
    };
    const getSessionKey = (ctx: unknown, event: unknown): string | null => {
      const key = readField(ctx, "sessionKey") ?? readField(event, "sessionKey");
      return typeof key === "string" && key ? key : null;
    };
    const getAgentId = (ctx: unknown, event: unknown): string | null => {
      const id = readField(ctx, "agentId") ?? readField(event, "agentId");
      return typeof id === "string" && id ? id : null;
    };

    const trackModelCall = (ctx: unknown, event: unknown, failed: boolean): void => {
      try {
        const runKey = getRunKey(ctx, event);
        const sessionKey = getSessionKey(ctx, event);
        if (!runKey || !sessionKey) return;
        const agentId = getAgentId(ctx, event) ?? undefined;
        if (agentId && enabledAgents.size > 0 && !enabledAgents.has(agentId)) return;
        const modelId = readModelId(event);
        let usage = runs.get(runKey);
        if (!usage) {
          usage = {
            sessionKey,
            agentId,
            primaryFailed: false,
            fallbackUsed: false,
            fallbackFailed: false,
            calls: [],
          };
          runs.set(runKey, usage);
        }
        usage.calls.push({ model: modelId, failed });
        if (usage.calls.length > 8) usage.calls.shift();
        if (failed && isPrimaryModel(modelId)) usage.primaryFailed = true;
        if (isFallbackModel(modelId)) {
          usage.fallbackUsed = true;
          if (failed) usage.fallbackFailed = true;
        }
      } catch {
        // Observation must never break a run.
      }
    };

    api.on("model_call_ended", (event, ctx) => {
      trackModelCall(ctx, event, readCallFailed(event));
    });

    api.on("before_model_resolve", (event, ctx) => {
      // Records which model a turn is about to use; a fallback showing up
      // here is evidence even if its model call never completes.
      trackModelCall(ctx, event, false);
    });

    api.on("agent_end", (event, ctx) => {
      // Fire-and-forget: the 30s hook budget bounds the await, not the work.
      void (async () => {
        try {
          const runKey = getRunKey(ctx, event);
          const sessionKey = getSessionKey(ctx, event);
          if (!runKey || !sessionKey) return;
          const usage = runs.get(runKey);
          runs.delete(runKey);
          // Keep the map bounded on long-lived gateways.
          if (runs.size > 500) {
            const oldest = runs.keys().next().value;
            if (oldest) runs.delete(oldest);
          }
          const agentId = getAgentId(ctx, event) ?? usage?.agentId;
          if (agentId && enabledAgents.size > 0 && !enabledAgents.has(agentId)) return;
          if (!usage) return;

          // agent_end.success is true even when the run only produced an
          // error reply, so derive failure from the tracked model calls.
          const runFailed =
            readRunFailed(event) || usage.primaryFailed || usage.fallbackFailed;
          const callsSummary = usage.calls
            .map((c) => `${c.model ?? "?"}:${c.failed ? "fail" : "ok"}`)
            .join(",");
          log(
            `session ${sessionKey} run ${runKey}: agent_end success=${String(readField(event, "success"))} ` +
              `primaryFailed=${usage.primaryFailed} fallbackUsed=${usage.fallbackUsed} ` +
              `fallbackFailed=${usage.fallbackFailed} calls=[${callsSummary}]`,
          );
          const now = Date.now();
          const cached = sizeCache.get(sessionKey);
          let inputTokens: number | null;
          if (cached && now - cached.at < 60_000) {
            inputTokens = cached.tokens;
          } else {
            try {
              inputTokens = await getSessionInputTokens(sessionKey, {
                cliPath,
                timeoutMs: LIST_TIMEOUT_MS,
              });
              sizeCache.set(sessionKey, { tokens: inputTokens, at: now });
            } catch (err) {
              log(
                `session ${sessionKey}: could not read token count (${err instanceof Error ? err.message : String(err)}); skipping`,
              );
              return;
            }
          }

          const decision = shouldCompact({
            runFailed,
            primaryFailed: usage.primaryFailed,
            fallbackUsed: usage.fallbackUsed,
            inputTokens,
            tokenThreshold,
            lastCompactAt: lastCompactAt.get(sessionKey) ?? null,
            cooldownMs,
            now,
          });
          if (!decision.compact) {
            log(`session ${sessionKey}: no compaction (${decision.reason})`);
            return;
          }

          if (dryRun) {
            log(`session ${sessionKey}: DRY RUN — would compact (${decision.reason})`);
            return;
          }

          log(`session ${sessionKey}: compacting (${decision.reason})`);
          lastCompactAt.set(sessionKey, now);
          try {
            const reply = await compactSession(sessionKey, {
              cliPath,
              timeoutMs: COMPACT_TIMEOUT_MS,
            });
            log(`session ${sessionKey}: compaction finished: ${reply.slice(0, 500)}`);
          } catch (err) {
            log(
              `session ${sessionKey}: compaction failed (${err instanceof Error ? err.message : String(err)})`,
            );
          }
        } catch {
          // Observation must never break a run.
        }
      })();
    });
  },
});
