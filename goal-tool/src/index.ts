/**
 * goal-tool — the `goal` tool as a proper OpenClaw tool plugin.
 *
 * WHY A SEPARATE PLUGIN: the runtime only exposes a tool to agents when
 * the tool is declared via `defineToolPlugin` (the tool metadata is
 * attached to the plugin entry, and the runtime reads that metadata to
 * build agents' tool lists). Registering a tool at runtime with
 * `api.registerTool` inside a `definePluginEntry` does NOT make it
 * visible — the factory is never called and the agent gets
 * "Tool named goal is not available". So the tool lives here
 * (defineToolPlugin) and the turn-end Judge + push live in the sibling
 * `goal` plugin (definePluginEntry, agent_end hook). Both share the
 * same registry (goal.db) and the same handler (handleGoalAction).
 *
 * The tool is a factory: each call is bound to the calling session's
 * sessionKey/agentId (from the toolContext). The factory never returns
 * null for a missing sessionKey — it derives the agent's main session
 * key from the agent id, so the tool registers even when the runtime
 * calls the factory once globally to extract static metadata.
 */
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { handleGoalAction, DEFAULT_CONFIG, type GoalConfig } from "../../goal-plugin/dist/goal.js";
import { judgeGoal, type JudgeOptions } from "../../goal-plugin/dist/judge.js";
import { openRegistry } from "../../goal-plugin/dist/registry.js";
import { GOAL_TOOL_DESCRIPTION } from "../../goal-plugin/dist/prompts.js";

const GoalParamsSchema = Type.Object(
  {
    action: Type.String({
      enum: ["get", "create", "link", "complete", "wait", "resume", "clear",
        "list", "search", "update", "set_status", "create_entry", "update_entry", "delete_entry", "delete"],
      description: "get | create | link | complete | wait | resume | clear | list | search | update | set_status | create_entry | update_entry | delete_entry | delete",
    }),
    objective: Type.Optional(Type.String({ description: "For create: the outcome in one sentence, verifiable, 12-600 chars." })),
    evidence: Type.Optional(Type.String({ description: "For complete: what proves the acceptance criteria are met (commands run, URLs, ids)." })),
    acceptance_criteria: Type.Optional(Type.String({ description: "For create: the observable end state the completion audit checks." })),
    verification: Type.Optional(Type.String({ description: "For create: how the audit confirms the criteria (commands, URLs, checks)." })),
    user_ask: Type.Optional(Type.String({ description: "For create: the original user ask this goal comes from (so the judge can check the criteria against it)." })),
    replace: Type.Optional(Type.Boolean({ description: "For create: replace the agent's own current goal because the user redirected the work. Refused for user-set goals." })),
    task_ids: Type.Optional(Type.Array(Type.String(), { description: "For create/link: kanban card ids (t_...) this goal is about." })),
    max_turns: Type.Optional(Type.Integer({ description: "For create: optional continuation budget; default 20." })),
    on: Type.Optional(Type.String({ description: "For wait: subagents | process | seconds | user." })),
    process_session: Type.Optional(Type.String({ description: "For wait on=process: the process session id." })),
    seconds: Type.Optional(Type.Integer({ description: "For wait on=seconds: how long." })),
    question: Type.Optional(Type.String({ description: "For wait on=user: the one concrete question for the user." })),
    reason: Type.Optional(Type.String({ description: "For wait/set_status: one line on why (required for set_status)." })),
    query: Type.Optional(Type.String({ description: "For search: text to match (min 2 chars) against goal, criteria, and entry titles/descriptions." })),
    status: Type.Optional(Type.String({ description: "For set_status: active | completed." })),
    confirm: Type.Optional(Type.Boolean({ description: "For delete: must be true — delete removes the goal row permanently." })),
    update_id: Type.Optional(Type.String({ description: "For update_entry/delete_entry: the entry id (from create_entry)." })),
    title: Type.Optional(Type.String({ description: "For create_entry/update_entry: the entry title." })),
    current_state: Type.Optional(Type.String({ description: "For create_entry/update_entry: the entry's current state." })),
    description: Type.Optional(Type.String({ description: "For create_entry/update_entry: the entry detail." })),
    effective_at: Type.Optional(Type.Number({ description: "For create_entry/update_entry: Unix-ms timestamp the entry is dated at; defaults to now." })),
    subgoals: Type.Optional(Type.Array(Type.String(), { description: "For update: replaces the goal's subgoals list." })),
  },
  { additionalProperties: false },
);

const GoalToolConfigSchema = Type.Object({
  judgeModel: Type.Optional(Type.String()),
  judgeTimeoutMs: Type.Optional(Type.Number()),
  maxStalledTurns: Type.Optional(Type.Number()),
  maxJudgeOutages: Type.Optional(Type.Number()),
  maxParseFailures: Type.Optional(Type.Number()),
  defaultMaxTurns: Type.Optional(Type.Number()),
  enabledAgents: Type.Optional(Type.Array(Type.String())),
  cliPath: Type.Optional(Type.String()),
  pushTimeoutSeconds: Type.Optional(Type.Number()),
  dbPath: Type.Optional(Type.String()),
  dryRun: Type.Optional(Type.Boolean()),
});

function resolveStateDir(): string {
  const env = process.env.OPENCLAW_STATE_DIR?.trim();
  if (env) return env;
  return join(homedir(), ".openclaw", "state");
}

export default defineToolPlugin({
  id: "goal-tool",
  name: "Goal Tool",
  description: "The goal tool: the agent declares its session goal, reads it back, and completes it (audited by the Judge).",
  configSchema: GoalToolConfigSchema,
  tools: (tool) => [
    tool({
      name: "goal",
      label: "Goal",
      description: GOAL_TOOL_DESCRIPTION,
      parameters: GoalParamsSchema,
      factory: (ctx) => {
        const toolContext = ctx.toolContext ?? {};
        const agentId = typeof toolContext.agentId === "string" ? toolContext.agentId : "";
        let sessionKey = typeof toolContext.sessionKey === "string" ? toolContext.sessionKey : "";
        if (!sessionKey && agentId) sessionKey = `agent:${agentId}:main`;
        const pc = (ctx.config ?? {}) as Record<string, unknown>;
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
        };
        const enabledAgents = new Set(
          (Array.isArray(pc.enabledAgents) ? pc.enabledAgents : []).filter((a): a is string => typeof a === "string" && !!a.trim()),
        );
        if (enabledAgents.size > 0 && agentId && !enabledAgents.has(agentId)) return null;
        const dbPath =
          typeof pc.dbPath === "string" && pc.dbPath.trim()
            ? pc.dbPath.trim()
            : join(resolveStateDir(), "goal.db");
        let db: DatabaseSync | null = null;
        const getDb = (): DatabaseSync => {
          if (!db) db = openRegistry(dbPath);
          return db;
        };
        return {
          name: "goal",
          label: "Goal",
          description: GOAL_TOOL_DESCRIPTION,
          parameters: GoalParamsSchema,
          execute: async (_toolCallId: string, params: unknown) => {
            const p = (params ?? {}) as Record<string, unknown>;
            if (!sessionKey) {
              const err = { ok: false, error: "goal tool has no session context (no sessionKey and no agentId); call it from an agent session" };
              return { content: [{ type: "text", text: JSON.stringify(err, null, 2) }], details: err };
            }
            const judgeOpts: JudgeOptions = {
              agentId,
              judgeModel: cfg.judgeModel,
              cliPath: cfg.cliPath,
              timeoutMs: cfg.judgeTimeoutMs,
            };
            const result = await handleGoalAction(
              getDb(),
              sessionKey,
              agentId,
              {
                action: String(p.action ?? ""),
                objective: typeof p.objective === "string" ? p.objective : undefined,
                evidence: typeof p.evidence === "string" ? p.evidence : undefined,
                acceptance_criteria: typeof p.acceptance_criteria === "string" ? p.acceptance_criteria : undefined,
                verification: typeof p.verification === "string" ? p.verification : undefined,
                user_ask: typeof p.user_ask === "string" ? p.user_ask : undefined,
                replace: p.replace === true,
                task_ids: Array.isArray(p.task_ids) ? (p.task_ids as unknown[]).filter((t): t is string => typeof t === "string") : undefined,
                max_turns: typeof p.max_turns === "number" ? p.max_turns : undefined,
                on: typeof p.on === "string" ? p.on : undefined,
                process_session: typeof p.process_session === "string" ? p.process_session : undefined,
                seconds: typeof p.seconds === "number" ? p.seconds : undefined,
                question: typeof p.question === "string" ? p.question : undefined,
                reason: typeof p.reason === "string" ? p.reason : undefined,
                query: typeof p.query === "string" ? p.query : undefined,
                status: typeof p.status === "string" ? p.status : undefined,
                confirm: p.confirm === true,
                update_id: typeof p.update_id === "string" ? p.update_id : undefined,
                title: typeof p.title === "string" ? p.title : undefined,
                current_state: typeof p.current_state === "string" ? p.current_state : undefined,
                description: typeof p.description === "string" ? p.description : undefined,
                effective_at: typeof p.effective_at === "number" ? p.effective_at : undefined,
                subgoals: Array.isArray(p.subgoals) ? (p.subgoals as unknown[]).filter((t): t is string => typeof t === "string") : undefined,
              },
              cfg,
              (input) => judgeGoal(input, judgeOpts),
            );
            const text = JSON.stringify(result, null, 2);
            return { content: [{ type: "text", text }], details: result };
          },
        };
      },
    }),
  ],
});
