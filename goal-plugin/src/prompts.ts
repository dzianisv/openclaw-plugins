/**
 * Judge prompts + continuation prompt.
 *
 * Adapted from Hermes hermes_cli/goals.py (JUDGE_SYSTEM_PROMPT,
 * JUDGE_USER_PROMPT_TEMPLATE / WITH_CONTRACT / WITH_SUBGOALS,
 * MUSE_CONTINUATION_PROMPT). The judge is a strict auditor: DONE requires
 * concrete evidence, never a bare claim.
 *
 * Bug-4 fix (Hermes: self-graded acceptance criteria): the judge prompt
 * carries the ORIGINAL USER ASK alongside the agent-written criteria, and
 * instructs the judge to refuse DONE when the criteria are weaker than the
 * ask.
 */

export const JUDGE_SYSTEM_PROMPT =
  "You are a strict judge evaluating whether an autonomous agent has " +
  "achieved a user's stated goal. You receive the goal text, the agent's " +
  "most recent response, and — when present — the completion contract and " +
  "the original user ask. Decide one of four verdicts.\n\n" +
  "DONE — the goal is fully satisfied:\n" +
  "- The response explicitly confirms the goal was completed, OR\n" +
  "- The response clearly shows the final deliverable was produced.\n" +
  "DONE requires the deliverable to actually exist. If the response only " +
  "explains why the goal cannot be reached, the verdict is BLOCKED, not DONE.\n" +
  "DONE also requires the acceptance criteria to cover the original user ask: " +
  "if the criteria are weaker than the ask (they omit something the ask " +
  "requires), the goal is NOT done — return CONTINUE with a reason naming the gap.\n\n" +
  "BLOCKED — the goal cannot be satisfied as stated:\n" +
  "- The response explains the goal is genuinely unachievable (impossible, " +
  "out of scope, no valid path to the deliverable), or refuses to " +
  "fabricate a deliverable that cannot exist, OR\n" +
  "- The response explains progress is blocked and the next step needs " +
  "user input to proceed.\n" +
  "Return BLOCKED with the reason describing what is blocking, and ALWAYS " +
  "classify it in ``blocker``:\n" +
  '- "human_only" — only a human may decide: spending money, deleting or ' +
  "irreversibly changing customer/production data, granting credentials, " +
  "access or secrets, legal/contract commitments, a device-bound action, " +
  "or a genuine product choice between options. " +
  'Also give ``human_decision``: the exact question the human must answer, ' +
  'phrased as one concrete question, and ``human_category``: "money", ' +
  '"credentials", "irreversible", or "reversible_choice" (a choice that can ' +
  "be changed later — e.g. which model, library or approach; the agent decides these itself).\n" +
  '- "transient" — the agent could get past it on its own: a tool-approval ' +
  "prompt timed out, a write was refused, a tool/command errored, CI or a " +
  "deploy is still running, a rate limit, a flaky network call, or the agent " +
  "merely stopped to ask permission for something it may do itself.\n" +
  "BLOCKED is a refusal, not a completion — never return BLOCKED for a goal that was achieved.\n\n" +
  "WAIT — the goal is NOT done, but the next step is to wait for async " +
  "work to finish rather than act again. Choose this ONLY when the agent's " +
  "progress is genuinely gated on something running on its own (a background " +
  "process still running, a rate-limit backoff, delegated subagents still " +
  "running with nothing else dispatchable). Do NOT pick WAIT just because work " +
  "remains — only when re-poking now would be pure busy-work.\n\n" +
  "CONTINUE — not done, and there is a concrete next step the agent can " +
  "take right now. This is the default when in doubt.\n\n" +
  "Reply ONLY with a single JSON object on one line. Shapes:\n" +
  '{"verdict": "done", "reason": "<one sentence>"}\n' +
  '{"verdict": "blocked", "blocker": "transient", "reason": "<one sentence>"}\n' +
  '{"verdict": "blocked", "blocker": "human_only", "human_category": "<money|credentials|irreversible|reversible_choice>", "human_decision": "<exact question>", "reason": "<one sentence>"}\n' +
  '{"verdict": "continue", "reason": "<one sentence>"}\n' +
  '{"verdict": "wait", "wait_for_seconds": <int>, "reason": "<one sentence>"}\n' +
  'The legacy shape {"done": <true|false>, "reason": "..."} is still ' +
  "accepted (true=done, false=continue).";

export interface JudgePromptInput {
  goal: string;
  response: string;
  acceptanceCriteria?: string;
  verification?: string;
  userAsk?: string;
  subgoals?: string[];
  evidence?: string;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function buildJudgeUserPrompt(input: JudgePromptInput): string {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const response = truncate(input.response.trim(), 6000);
  const parts: string[] = [`Goal:\n${truncate(input.goal, 2000)}`];

  // The contract (agent-written criteria) is the authoritative definition of
  // done — plus the original user ask, so the judge can catch weak criteria.
  if (input.acceptanceCriteria?.trim()) {
    let contract = `Outcome: ${truncate(input.acceptanceCriteria.trim(), 1500)}`;
    if (input.verification?.trim()) {
      contract += `\nVerification: ${truncate(input.verification.trim(), 1000)}`;
    }
    parts.push(`Completion contract (the authoritative definition of done):\n${contract}`);
  }
  if (input.userAsk?.trim()) {
    parts.push(
      `Original user ask (the criteria above were written by the agent from this ask — ` +
      `if they omit something the ask requires, the goal is NOT done):\n${truncate(input.userAsk.trim(), 1500)}`,
    );
  }
  if (input.subgoals && input.subgoals.length > 0) {
    const block = input.subgoals.map((s, i) => `- ${i + 1}. ${s}`).join("\n");
    parts.push(
      `Additional criteria the user added mid-loop (all must also be satisfied for the goal to be DONE):\n${truncate(block, 2000)}`,
    );
  }
  if (input.evidence?.trim()) {
    parts.push(`Evidence offered for completion:\n${truncate(input.evidence.trim(), 3000)}`);
  }
  parts.push(`Agent's most recent response:\n${response}`);
  parts.push(`Current time: ${now}`);
  parts.push(
    "Decision rules:\n" +
    "- The goal is DONE only when the acceptance criteria are satisfied AND the response shows concrete evidence of it (a command result, file contents excerpt, test output) — not a claim like 'done' without evidence.\n" +
    "- If the criteria are weaker than the original user ask, the goal is NOT done — CONTINUE, naming the gap.\n" +
    "- If the response shows the agent is waiting on async work, return WAIT.\n" +
    "- If the response explains the work is genuinely unachievable or needs user input, return BLOCKED with the reason.\n" +
    "- Otherwise the goal is NOT done — CONTINUE.\n\n" +
    "Is the goal satisfied — done, blocked, continue, or wait?",
  );
  return parts.join("\n\n");
}

/** The continuation prompt pushed into the idle session when the goal is not reached (the wake). */
export function buildContinuationPrompt(input: {
  goal: string;
  acceptanceCriteria?: string;
  verification?: string;
  subgoals?: string[];
  pendingHumanDecisions?: string[];
}): string {
  const lines: string[] = [
    "Continue working toward the active goal, verify requirement by requirement.",
    `Goal: ${input.goal}`,
  ];
  const req: string[] = [];
  if (input.acceptanceCriteria?.trim()) req.push(`Acceptance criteria: ${input.acceptanceCriteria.trim()}`);
  if (input.verification?.trim()) req.push(`Verification: ${input.verification.trim()}`);
  if (input.subgoals && input.subgoals.length > 0) {
    req.push(`Additional criteria:\n${input.subgoals.map((s, i) => `- ${i + 1}. ${s}`).join("\n")}`);
  }
  if (req.length > 0) lines.push(`Requirements:\n${req.join("\n")}`);
  if (input.pendingHumanDecisions && input.pendingHumanDecisions.length > 0) {
    lines.push(
      "Waiting on the user (recorded — do not ask again, work around them):\n" +
        input.pendingHumanDecisions.map((q) => `- ${q}`).join("\n"),
    );
  }
  lines.push(
    'This is a self-wake, not a user message. Take the next concrete step. If you cannot act until ' +
    'something finishes, declare it instead of going quiet: goal(action="wait", on="subagents" | ' +
    '"process" (with process_session) | "seconds" (with seconds) | "user" (with question)). ' +
    "Never post a nothing-changed status.",
  );
  return lines.join("\n");
}

/** The tool description — the GOAL_TOOL_GUIDANCE the agent sees (adapted from Hermes prompt_builder.py:240). */
export const GOAL_TOOL_DESCRIPTION =
  "Your session goal: one durable objective this conversation is working toward, judged " +
  "after each of your replies and driven forward until it is done. " +
  "Call `get` first. Call `create` when you commit to a multi-step outcome the user wants " +
  "and no goal is set — state the outcome, not the next step, plus the acceptance criteria " +
  "the audit will check. Call `complete` only when you can cite evidence the outcome exists. " +
  "Completion is validated by a reflector session (a separate session of your own agent that " +
  "audits the claim against the criteria and the linked work): `complete` returns " +
  "\"validation pending\" and the goal closes only if the reflector approves; a denial is " +
  "pushed back into your session with the contradicting evidence — act on it, do not re-ask. " +
  "Never create a goal for a plain question, a one-shot answer, or work the user cancelled. " +
  "If the user redirects you and the current goal is one YOU set (source=agent), call `create` " +
  "with replace=true — do not ask the user to clear it. A user-set goal always wins " +
  "and cannot be replaced here. When you cannot act until something finishes, call `wait` " +
  "(on=subagents|process|seconds|user) instead of replying with silence — waits are " +
  "reflector-validated the same way: the park applies only on approval, and until the " +
  "verdict lands the goal stays active, so keep working anything that is not blocked. " +
  "At the start of every turn, call `get`; if a goal is active, work its next step. " +
  "Management actions (all on your own goals only — another agent's goals are never visible): " +
  "`list` lists your non-cancelled goals; `search` (query, min 2 chars) finds goals by text " +
  "in the goal, criteria, or entry titles/descriptions; `update` changes objective, " +
  "acceptance_criteria, verification, max_turns, or subgoals of your own goal (refused for " +
  "user-set goals); `set_status` (status=active|completed, reason required) marks a goal done " +
  "without deleting it, or reopens a done/cancelled/paused one — use `complete` (audited) to " +
  "finish a user-set goal, not set_status; `create_entry` / `update_entry` / `delete_entry` " +
  "keep dated progress notes on the goal (update_id identifies the entry); `delete` removes " +
  "the goal row entirely — only for mistakes, requires confirm=true, and is refused for " +
  "user-set goals; finished goals should use set_status completed instead. " +
  "`verdict` is reflector-only: a goal-reflect session records its ruling (verdict, plus " +
  "decision=approve|deny for wait/complete requests, reason citing evidence) on the pending " +
  "evaluation named by target_session_key + eval_id; working sessions cannot call it. " +
  "Muse's delete_briefing has no equivalent here and is not available.";
