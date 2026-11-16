#!/usr/bin/env node
/**
 * goal-admin — operator CLI for the goal registry.
 *
 * Usage (run as engineer on dev-1, from the plugin dir):
 *   node scripts/goal-admin.mjs set-user-goal <sessionKey> <agentId> "<objective>" "<acceptanceCriteria>" "<verification>" ["<userAsk>"]
 *   node scripts/goal-admin.mjs get <sessionKey>
 *   node scripts/goal-admin.mjs list
 *   node scripts/goal-admin.mjs search <query>
 *   node scripts/goal-admin.mjs clear <sessionKey>
 *
 * A user-set goal always wins and cannot be replaced by the agent's create.
 * DB: <openclaw state dir>/goal.db (or $GOAL_DB).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { openRegistry, getGoal, listGoals, saveGoal, statusLine } from "../dist/registry.js";
import { setUserGoal } from "../dist/goal.js";

const dbPath = process.env.GOAL_DB || join(process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw", "state"), "goal.db");

function usage() {
  console.log("usage:");
  console.log('  goal-admin.mjs set-user-goal <sessionKey> <agentId> "<objective>" "<acceptanceCriteria>" "<verification>" ["<userAsk>"]');
  console.log("  goal-admin.mjs get <sessionKey>");
  console.log("  goal-admin.mjs list");
  console.log("  goal-admin.mjs search <query>");
  console.log("  goal-admin.mjs clear <sessionKey>");
  process.exit(2);
}

const [cmd, ...rest] = process.argv.slice(2);
const db = openRegistry(dbPath);

if (cmd === "set-user-goal") {
  const [sessionKey, agentId, objective, acceptanceCriteria = "", verification = "", userAsk = ""] = rest;
  if (!sessionKey || !agentId || !objective) usage();
  const g = setUserGoal(db, sessionKey, agentId, objective, acceptanceCriteria, verification, userAsk || objective);
  console.log(JSON.stringify({ set: true, sessionKey, agentId, status: g.status, source: g.source, goal: g.goal }, null, 2));
} else if (cmd === "get") {
  const [sessionKey] = rest;
  if (!sessionKey) usage();
  const g = getGoal(db, sessionKey);
  if (!g) { console.log(JSON.stringify({ goal: null })); process.exit(0); }
  console.log(JSON.stringify(g, null, 2));
  console.log(statusLine(g));
} else if (cmd === "list") {
  const goals = listGoals(db);
  for (const g of goals) console.log(statusLine(g));
  if (goals.length === 0) console.log("(no goals)");
} else if (cmd === "search") {
  const [query] = rest;
  if (!query || query.length < 2) usage();
  const q = query.toLowerCase();
  const goals = listGoals(db).filter((g) => {
    const hay = [g.goal, g.acceptanceCriteria, ...g.entries.flatMap((e) => [e.title, e.description])].join("\n").toLowerCase();
    return hay.includes(q);
  });
  for (const g of goals) console.log(statusLine(g));
  if (goals.length === 0) console.log("(no matches)");
} else if (cmd === "clear") {
  const [sessionKey] = rest;
  if (!sessionKey) usage();
  const g = getGoal(db, sessionKey);
  if (!g) { console.log(JSON.stringify({ cleared: false, goal: null })); process.exit(0); }
  g.status = "cancelled";
  saveGoal(db, g);
  console.log(JSON.stringify({ cleared: true, sessionKey }));
} else {
  usage();
}
db.close();
