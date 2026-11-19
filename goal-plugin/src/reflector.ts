/**
 * The reflector — a standing agent session that grades goals.
 *
 * One reflector session per agent: `agent:<agentId>:goal-reflect`. It is
 * a real session of the same agent (same tools, same model), driven by
 * the plugin through `api.session.workflow.scheduleSessionTurn`. It
 * replaces the one-shot judge for turn-end grading AND for validating
 * wait/complete requests: unlike the one-shot call it can investigate —
 * read the goal with the goal tool, check the linked work itself, look
 * at files — before it rules.
 *
 * The verdict channel is the goal tool's `verdict` action: the reflector
 * calls it with the target session key + eval id from its evaluation
 * prompt, and the verdict lands on the target goal's registry row. The
 * plugin is the only writer of goal STATUS: it applies the verdict when
 * the reflector's turn ends. As a fallback, the plugin also parses a
 * verdict JSON out of the reflector's final reply text.
 *
 * A session is materialized by the gateway when its first scheduled turn
 * runs — there is no createSession API, and none is needed.
 */
import { parseJudgeResponse } from "./judge.js";
import type { GoalRow, ReflectorVerdict } from "./registry.js";
import type { LinkedItemState } from "./nudge.js";

export function reflectorSessionKey(agentId: string): string {
  return `agent:${agentId}:goal-reflect`;
}

export function isReflectorSession(sessionKey: string): boolean {
  return sessionKey.endsWith(":goal-reflect");
}

/** Seeded into the reflector session on its first evaluation for an agent. */
export const REFLECTOR_SEED =
  "STANDING ROLE — goal reflector. You are the standing reflector session for your agent. " +
  "The goal plugin sends you evaluation requests for goals owned by your agent's working sessions. " +
  "For each request: (1) read the goal state (it is quoted in the request; you may re-read it with " +
  'the goal tool — action "list" shows your agent\'s goals), (2) verify the claim against evidence — ' +
  "use your own tools (gh, exec, file reads) when the quoted evidence is not enough, " +
  "(3) rule, and record the ruling by calling the goal tool's verdict action exactly once, with the " +
  "target_session_key and eval_id from the request. Rules: DONE requires concrete evidence the " +
  "acceptance criteria are met — a bare claim is not evidence. A wait/complete request is APPROVED " +
  "only when the stated reason checks out (for a wait on subagents: the linked work is genuinely " +
  "still running/open and nothing else is dispatchable; for a completion: the criteria are provably " +
  "met). Otherwise DENY it, with the contradicting evidence in the reason. NO BLOCKERS: there are no " +
  "blockers except a required payment (exact amount + billing-record proof) or a credential proven " +
  "absent after checking secretsmctl (projects agentpod, vibebrowser, shared_infra), the host .env " +
  "files, and the credentials store — an unproven blocker claim is denied, never approved. " +
  "You never work the goal yourself and never message anyone about it; your only output is the verdict.";

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function linkedBlock(linkedStates: LinkedItemState[]): string {
  if (linkedStates.length === 0) return "Linked work: none recorded on the goal.";
  return (
    "Linked work (checked mechanically by the plugin just now):\n" +
    linkedStates.map((s) => `- ${s.id} — ${s.state.toUpperCase()}${s.detail ? ` — ${s.detail}` : ""}`).join("\n")
  );
}

/**
 * The evaluation prompt sent into the reflector session. `kind` is the
 * pending evaluation's kind; for wait/complete the agent's recorded claim
 * is in `claim`; for turn-end the graded response is in `response`.
 */
export function buildReflectorPrompt(input: {
  evalId: string;
  targetSessionKey: string;
  goal: GoalRow;
  kind: "turn-end" | "wait" | "complete";
  claim?: string;
  response?: string;
  linkedStates: LinkedItemState[];
  seeded: boolean;
}): string {
  const g = input.goal;
  const lines: string[] = [];
  if (input.seeded) lines.push(REFLECTOR_SEED, "");
  lines.push(
    "[goal plugin] Evaluation request — you are the reflector; rule on this and record the verdict.",
    `eval_id: ${input.evalId}`,
    `target_session_key: ${input.targetSessionKey}`,
    `Goal: ${g.goal}`,
  );
  if (g.acceptanceCriteria.trim()) lines.push(`Acceptance criteria: ${g.acceptanceCriteria.trim()}`);
  if (g.verification.trim()) lines.push(`Verification: ${g.verification.trim()}`);
  if (g.userAsk.trim()) lines.push(`Original user ask: ${truncate(g.userAsk.trim(), 800)}`);
  if (g.subgoals.length > 0) lines.push(`Additional criteria:\n${g.subgoals.map((s, i) => `- ${i + 1}. ${s}`).join("\n")}`);
  lines.push(`Goal status: ${g.status} · turns used ${g.turnsUsed}/${g.maxTurns} · last verdict: ${g.lastVerdict || "-"}`);
  lines.push(linkedBlock(input.linkedStates));

  if (input.kind === "turn-end") {
    lines.push(
      "",
      "TASK — grade the working session's last turn against the goal. Decide one verdict:",
      '- "done": the criteria are provably met (evidence, not claims).',
      '- "continue": not done; a concrete next step exists.',
      '- "blocked": genuinely unachievable, or the next step needs a human decision — classify blocker as "transient" or "human_only" (with human_category + human_decision).',
      '- "wait": not done, but the next step is genuinely to wait for async work (give wait_for_seconds).',
      "",
      `The working agent's last response:\n${truncate((input.response || "").trim(), 4000)}`,
    );
  } else if (input.kind === "wait") {
    lines.push(
      "",
      "TASK — the working agent asked to PARK this goal (goal wait). Parking on its own word is exactly what you exist to prevent. Decide:",
      '- APPROVE (decision "approve", verdict "wait") only if the wait is real: the linked work is still open/running AND nothing else is dispatchable in the meantime.',
      '- DENY (decision "deny") if any linked item is already closed, if work remains that the agent can do now, or if the stated reason is an unproven blocker claim.',
      "",
      `The agent's wait claim:\n${truncate((input.claim || "").trim(), 2000)}`,
    );
  } else {
    lines.push(
      "",
      "TASK — the working agent claims this goal is COMPLETE. Decide:",
      '- APPROVE (decision "approve", verdict "done") only if the evidence proves every acceptance criterion is met.',
      '- DENY (decision "deny") if the evidence is missing, partial, or contradicts a criterion — name the gap.',
      "",
      `The agent's completion claim + evidence:\n${truncate((input.claim || "").trim(), 3000)}`,
    );
  }

  lines.push(
    "",
    "Record the ruling NOW by calling the goal tool exactly once:",
    `goal(action="verdict", target_session_key="${input.targetSessionKey}", eval_id="${input.evalId}", ` +
      'verdict="done|continue|blocked|wait", decision="approve|deny" (requests only), reason="<one or two sentences, citing the evidence>")',
    "Then end your turn with one plain line restating the verdict + reason (the plugin reads the tool record; the line is the backup channel). Do not do any of the goal's work yourself.",
  );
  return lines.join("\n");
}

/**
 * Fallback verdict channel: parse a verdict JSON out of the reflector's
 * final reply text. Accepts the judge JSON shapes (parseJudgeResponse)
 * plus an explicit "decision": "approve"|"deny" for request evals.
 */
export function parseReflectorVerdict(raw: string): ReflectorVerdict | null {
  const text = (raw || "").trim();
  if (!text) return null;
  const parsed = parseJudgeResponse(text);
  if (parsed.parseFailed) return null;
  let decision: "approve" | "deny" | undefined;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      const d = typeof obj.decision === "string" ? obj.decision.toLowerCase().trim() : "";
      if (d === "approve" || d === "deny") decision = d;
    } catch {
      // parseJudgeResponse already validated the shape; decision stays unset.
    }
  }
  return {
    verdict: parsed.verdict,
    reason: parsed.reason,
    decision,
    blocker: parsed.blocker,
    humanCategory: parsed.humanCategory,
    humanDecision: parsed.humanDecision,
    waitForSeconds: parsed.waitForSeconds,
    at: Date.now(),
  };
}
