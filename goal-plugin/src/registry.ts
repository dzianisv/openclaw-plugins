/**
 * goal registry — one goal row per agent session, in SQLite.
 *
 * Keyed to the session KEY (e.g. `agent:product-lead-agentpod:main`), NOT a
 * rotating session id. The session key survives compaction/rotation, which
 * fixes Hermes bug 1 (the goal died at context compression because the
 * registry keyed on a rotating session_id).
 *
 * The live goal state lives ONLY here. Never in a file (no GOAL_STATE.md),
 * never in AGENTS.md. The agent reads it via goal(action="get").
 *
 * DB file: <openclaw state dir>/goal.db — a separate file from the
 * gateway's own openclaw.sqlite, so the plugin never contends with the
 * gateway's writes.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type GoalStatus = "active" | "waiting" | "done" | "cancelled" | "paused";
export type GoalSource = "user" | "agent";

/**
 * A dated progress note on a goal, mirroring Muse's user_goal entries
 * (create_entry / update_entry / delete_entry). Stored as JSON in the row,
 * like linkedTaskIds / subgoals. `effective_at` is a Unix-ms timestamp;
 * `id` is a random UUID assigned at creation.
 */
export interface GoalEntry {
  id: string;
  title: string;
  current_state: string;
  description: string;
  effective_at: number;
}

export interface GoalRow {
  sessionKey: string;
  agentId: string;
  goal: string;
  acceptanceCriteria: string;
  verification: string;
  /** The original user ask, recorded so the judge can check the criteria against it (Hermes bug 4 fix). */
  userAsk: string;
  status: GoalStatus;
  source: GoalSource;
  linkedTaskIds: string[];
  subgoals: string[];
  gates: string[];
  entries: GoalEntry[];
  maxTurns: number;
  turnsUsed: number;
  createdAt: number;
  updatedAt: number;
  lastVerdict: string;
  lastReason: string;
  lastResponseSnippet: string;
  consecutiveStalled: number;
  consecutiveTransportFailures: number;
  consecutiveParseFailures: number;
  judgeOutageAlerted: boolean;
  waitingOn: string;
  waitingReason: string;
  waitingUntil: number;
  pendingHumanDecisions: string[];
  revision: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (
  session_key TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  verification TEXT NOT NULL DEFAULT '',
  user_ask TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'agent',
  linked_task_ids TEXT NOT NULL DEFAULT '[]',
  subgoals TEXT NOT NULL DEFAULT '[]',
  gates TEXT NOT NULL DEFAULT '[]',
  entries TEXT NOT NULL DEFAULT '[]',
  max_turns INTEGER NOT NULL DEFAULT 20,
  turns_used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  last_verdict TEXT NOT NULL DEFAULT '',
  last_reason TEXT NOT NULL DEFAULT '',
  last_response_snippet TEXT NOT NULL DEFAULT '',
  consecutive_stalled INTEGER NOT NULL DEFAULT 0,
  consecutive_transport_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_parse_failures INTEGER NOT NULL DEFAULT 0,
  judge_outage_alerted INTEGER NOT NULL DEFAULT 0,
  waiting_on TEXT NOT NULL DEFAULT '',
  waiting_reason TEXT NOT NULL DEFAULT '',
  waiting_until INTEGER NOT NULL DEFAULT 0,
  pending_human_decisions TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1
);
`;

function parseJsonArray(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonEntries(raw: string): GoalEntry[] {
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
      .map((x) => ({
        id: String(x.id ?? ""),
        title: String(x.title ?? ""),
        current_state: String(x.current_state ?? ""),
        description: String(x.description ?? ""),
        effective_at: Number(x.effective_at ?? 0),
      }))
      .filter((e) => e.id !== "");
  } catch {
    return [];
  }
}

function rowFromDb(r: Record<string, unknown>): GoalRow {
  return {
    sessionKey: String(r.session_key ?? ""),
    agentId: String(r.agent_id ?? ""),
    goal: String(r.goal ?? ""),
    acceptanceCriteria: String(r.acceptance_criteria ?? ""),
    verification: String(r.verification ?? ""),
    userAsk: String(r.user_ask ?? ""),
    status: (String(r.status ?? "active") as GoalStatus) || "active",
    source: (String(r.source ?? "agent") as GoalSource) || "agent",
    linkedTaskIds: parseJsonArray(String(r.linked_task_ids ?? "[]")),
    subgoals: parseJsonArray(String(r.subgoals ?? "[]")),
    gates: parseJsonArray(String(r.gates ?? "[]")),
    entries: parseJsonEntries(String(r.entries ?? "[]")),
    maxTurns: Number(r.max_turns ?? 20),
    turnsUsed: Number(r.turns_used ?? 0),
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
    lastVerdict: String(r.last_verdict ?? ""),
    lastReason: String(r.last_reason ?? ""),
    lastResponseSnippet: String(r.last_response_snippet ?? ""),
    consecutiveStalled: Number(r.consecutive_stalled ?? 0),
    consecutiveTransportFailures: Number(r.consecutive_transport_failures ?? 0),
    consecutiveParseFailures: Number(r.consecutive_parse_failures ?? 0),
    judgeOutageAlerted: Number(r.judge_outage_alerted ?? 0) === 1,
    waitingOn: String(r.waiting_on ?? ""),
    waitingReason: String(r.waiting_reason ?? ""),
    waitingUntil: Number(r.waiting_until ?? 0),
    pendingHumanDecisions: parseJsonArray(String(r.pending_human_decisions ?? "[]")),
    revision: Number(r.revision ?? 1),
  };
}

export function openRegistry(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  // Migration: DBs created before the entries column existed (pre-0.2.0)
  // get it added; CREATE TABLE IF NOT EXISTS does not alter old tables.
  const cols = db.prepare("PRAGMA table_info(goals)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "entries")) {
    db.exec("ALTER TABLE goals ADD COLUMN entries TEXT NOT NULL DEFAULT '[]'");
  }
  return db;
}

export function getGoal(db: DatabaseSync, sessionKey: string): GoalRow | null {
  const row = db.prepare("SELECT * FROM goals WHERE session_key = ?").get(sessionKey) as
    | Record<string, unknown>
    | undefined;
  return row ? rowFromDb(row) : null;
}

export function saveGoal(db: DatabaseSync, g: GoalRow): void {
  const now = Date.now();
  g.updatedAt = now;
  db.prepare(
    `INSERT INTO goals (
      session_key, agent_id, goal, acceptance_criteria, verification, user_ask,
      status, source, linked_task_ids, subgoals, gates, entries, max_turns, turns_used,
      created_at, updated_at, last_verdict, last_reason, last_response_snippet,
      consecutive_stalled, consecutive_transport_failures, consecutive_parse_failures,
      judge_outage_alerted, waiting_on, waiting_reason, waiting_until,
      pending_human_decisions, revision
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(session_key) DO UPDATE SET
      agent_id=excluded.agent_id, goal=excluded.goal,
      acceptance_criteria=excluded.acceptance_criteria, verification=excluded.verification,
      user_ask=excluded.user_ask, status=excluded.status, source=excluded.source,
      linked_task_ids=excluded.linked_task_ids, subgoals=excluded.subgoals,
      gates=excluded.gates, entries=excluded.entries, max_turns=excluded.max_turns, turns_used=excluded.turns_used,
      created_at=excluded.created_at, updated_at=excluded.updated_at,
      last_verdict=excluded.last_verdict, last_reason=excluded.last_reason,
      last_response_snippet=excluded.last_response_snippet,
      consecutive_stalled=excluded.consecutive_stalled,
      consecutive_transport_failures=excluded.consecutive_transport_failures,
      consecutive_parse_failures=excluded.consecutive_parse_failures,
      judge_outage_alerted=excluded.judge_outage_alerted,
      waiting_on=excluded.waiting_on, waiting_reason=excluded.waiting_reason,
      waiting_until=excluded.waiting_until,
      pending_human_decisions=excluded.pending_human_decisions,
      revision=excluded.revision`,
  ).run(
    g.sessionKey, g.agentId, g.goal, g.acceptanceCriteria, g.verification, g.userAsk,
    g.status, g.source, JSON.stringify(g.linkedTaskIds), JSON.stringify(g.subgoals),
    JSON.stringify(g.gates), JSON.stringify(g.entries), g.maxTurns, g.turnsUsed, g.createdAt, g.updatedAt,
    g.lastVerdict, g.lastReason, g.lastResponseSnippet, g.consecutiveStalled,
    g.consecutiveTransportFailures, g.consecutiveParseFailures,
    g.judgeOutageAlerted ? 1 : 0, g.waitingOn, g.waitingReason, g.waitingUntil,
    JSON.stringify(g.pendingHumanDecisions), g.revision,
  );
}

export function deleteGoal(db: DatabaseSync, sessionKey: string): void {
  db.prepare("DELETE FROM goals WHERE session_key = ?").run(sessionKey);
}

export function listGoals(db: DatabaseSync): GoalRow[] {
  const rows = db.prepare("SELECT * FROM goals ORDER BY session_key").all() as Record<string, unknown>[];
  return rows.map(rowFromDb);
}

/**
 * Goals visible to one agent: only rows whose agent_id matches the caller.
 * list/search NEVER expose another agent's goals — the registry is shared
 * across agents on one gateway, and goal text can contain user asks.
 */
export function listGoalsForAgent(db: DatabaseSync, agentId: string): GoalRow[] {
  const rows = db.prepare("SELECT * FROM goals WHERE agent_id = ? ORDER BY session_key").all(agentId) as Record<string, unknown>[];
  return rows.map(rowFromDb);
}

/** Human-readable status line (mirrors Hermes GoalManager.status_line). */
export function statusLine(g: GoalRow): string {
  const src = g.source === "user" ? "user-set" : "self-set";
  const base = `goal: ${g.goal} [${g.status}, ${src}, turn ${g.turnsUsed}/${g.maxTurns}]`;
  const verdict = g.lastVerdict ? ` last verdict: ${g.lastVerdict} — ${g.lastReason}` : "";
  const waiting = g.status === "waiting" && g.waitingReason ? ` waiting: ${g.waitingReason}` : "";
  return `${base}${verdict}${waiting}`;
}

export function newGoalRow(sessionKey: string, agentId: string): GoalRow {
  const now = Date.now();
  return {
    sessionKey, agentId, goal: "", acceptanceCriteria: "", verification: "", userAsk: "",
    status: "active", source: "agent", linkedTaskIds: [], subgoals: [], gates: [],
    entries: [],
    maxTurns: 20, turnsUsed: 0, createdAt: now, updatedAt: now,
    lastVerdict: "", lastReason: "", lastResponseSnippet: "",
    consecutiveStalled: 0, consecutiveTransportFailures: 0, consecutiveParseFailures: 0,
    judgeOutageAlerted: false, waitingOn: "", waitingReason: "", waitingUntil: 0,
    pendingHumanDecisions: [], revision: 1,
  };
}
