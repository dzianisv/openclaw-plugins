/**
 * The nudge — the goal plugin's external push.
 *
 * The turn-end Judge only runs when the goal's own session has turns. A
 * goal parked in waiting/subagents, or an active goal whose session went
 * idle, has no turns — so nothing ever wakes it. The nudge is the push
 * that lands anyway: it carries the goal's current state (status, last
 * verdict, linked-work state) plus the standing NO BLOCKERS pushback,
 * and it is delivered into the goal's OWN session via pushContinuation.
 *
 * Linked work: goal.linkedTaskIds holds free-form ids. Ids that resolve
 * to a GitHub issue (owner/repo#N or an issue URL) are checked live via
 * `gh`; a CLOSED issue is terminal. Anything else is "unknown" — never
 * treated as terminal, so an unresolvable id can never auto-resume a
 * goal on a guess.
 */
import { execFile } from "node:child_process";
import type { GoalRow } from "./registry.js";

export interface LinkedItemState {
  id: string;
  kind: "github-issue" | "unknown";
  state: "open" | "closed" | "unknown";
  detail: string;
}

export function parseIssueRef(id: string): { repo: string; number: number } | null {
  const url = id.match(/github\.com\/([^/\s]+)\/([^/\s#]+)\/issues\/(\d+)/);
  if (url) return { repo: `${url[1]}/${url[2]}`, number: Number(url[3]) };
  const full = id.match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/);
  if (full) return { repo: `${full[1]}/${full[2]}`, number: Number(full[3]) };
  return null;
}

function runGh(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(String(stdout));
    });
  });
}

export async function checkLinkedItem(id: string, timeoutMs: number): Promise<LinkedItemState> {
  const ref = parseIssueRef(id);
  if (!ref) {
    return {
      id,
      kind: "unknown",
      state: "unknown",
      detail: "not a resolvable GitHub issue ref (use owner/repo#N or an issue URL)",
    };
  }
  try {
    const out = await runGh(
      ["issue", "view", String(ref.number), "--repo", ref.repo, "--json", "state,title"],
      timeoutMs,
    );
    const parsed = JSON.parse(out) as { state?: string; title?: string };
    const st = String(parsed.state ?? "").toUpperCase();
    return {
      id,
      kind: "github-issue",
      state: st === "CLOSED" ? "closed" : st === "OPEN" ? "open" : "unknown",
      detail: String(parsed.title ?? "").slice(0, 120),
    };
  } catch (err) {
    return {
      id,
      kind: "github-issue",
      state: "unknown",
      detail: `gh check failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
    };
  }
}

export async function checkLinkedWork(ids: string[], timeoutMs: number): Promise<LinkedItemState[]> {
  const out: LinkedItemState[] = [];
  for (const id of ids) out.push(await checkLinkedItem(id, timeoutMs));
  return out;
}

/** Terminal = at least one linked item and every item provably closed. */
export function allLinkedTerminal(states: LinkedItemState[]): boolean {
  return states.length > 0 && states.every((s) => s.state === "closed");
}

/**
 * The standing NO BLOCKERS pushback (Den, 2026-11-19), baked into every
 * nudge. A blocker is exactly two things: a payment proven from the
 * provider's own billing record, or a credential proven absent from
 * every store. Everything else gets routed around, not reported.
 */
export const NO_BLOCKERS_PUSHBACK =
  "NO BLOCKERS — before you claim one, read this. There are NO blockers except: " +
  "(a) a required payment — stated as the exact amount + what it buys, proven from the provider's own billing record; and " +
  "(b) a credential that is missing after checking EVERY store. Credentials are not assumed missing: they live in " +
  "Bitwarden Secrets Manager and are fetched with secretsmctl (projects: agentpod, vibebrowser, shared_infra); also " +
  "check this host's .env files and the OpenClaw credentials store before claiming one is missing. A blocker claim " +
  "without that check is rejected — run the check and continue the work in the same turn. Everything else gets " +
  "routed around, not reported.";

const BLOCKER_CLAIM_RE =
  /\b(blocked|blocker|stuck|waiting on|no access|cannot access|can't access|need(s|ed)?\b[^.]{0,80}\b(fingerprint|credential|permission|approval|token|ssh|access)\b)/i;

/** If the agent's last response claimed a blocker, return the excerpt to reject. */
export function detectBlockerClaim(lastResponseSnippet: string): string {
  const text = (lastResponseSnippet || "").trim();
  if (!text) return "";
  const m = text.match(BLOCKER_CLAIM_RE);
  if (!m) return "";
  const start = Math.max(0, (m.index ?? 0) - 60);
  return text.slice(start, start + 300).replace(/\s+/g, " ").trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function buildNudgePrompt(
  goal: GoalRow,
  linkedStates: LinkedItemState[],
  opts: { wake: "periodic" | "resumed" | "linked-work-terminal"; rejectedClaim?: string },
): string {
  const lines: string[] = [
    "[goal plugin] This is a push from your goal plugin — not a user message. Your goal is not complete, so the loop does not stop: plan → dispatch → verify → repeat.",
    `Goal: ${goal.goal}`,
  ];
  if (goal.acceptanceCriteria?.trim()) lines.push(`Acceptance criteria: ${goal.acceptanceCriteria.trim()}`);
  if (goal.verification?.trim()) lines.push(`Verification: ${goal.verification.trim()}`);
  lines.push(
    `Status: ${goal.status} · turns used ${goal.turnsUsed}/${goal.maxTurns} · last verdict: ${goal.lastVerdict || "-"}` +
      (goal.lastReason ? ` — ${truncate(goal.lastReason, 400)}` : ""),
  );
  if (opts.wake === "resumed" || opts.wake === "linked-work-terminal") {
    lines.push(
      "Your goal was parked waiting on subagents. The linked work has reached a terminal state, so the goal is ACTIVE again — pick it up now.",
    );
  }
  if (linkedStates.length > 0) {
    lines.push(
      "Linked work:\n" +
        linkedStates.map((s) => `- ${s.id} — ${s.state.toUpperCase()}${s.detail ? ` — ${s.detail}` : ""}`).join("\n"),
    );
  } else {
    lines.push(
      'Linked work: none. When you dispatch work, link it so its completion can wake you: goal(action="link", task_ids=["owner/repo#N", ...]).',
    );
  }
  if (goal.pendingHumanDecisions.length > 0) {
    lines.push(
      "Waiting on the user (recorded — do not ask again, work around them):\n" +
        goal.pendingHumanDecisions.map((q) => `- ${truncate(q, 200)}`).join("\n"),
    );
  }
  if (opts.rejectedClaim) {
    lines.push(
      `REJECTED BLOCKER CLAIM: your last turn claimed a blocker ("${opts.rejectedClaim}"). It was not proven — no payment amount with billing-record proof, and no credential check across secretsmctl + .env + the credentials store. The claim is rejected: run the check now and continue the work in this same turn.`,
    );
  }
  lines.push(NO_BLOCKERS_PUSHBACK);
  lines.push(
    "Continue the loop in this turn: pick the next unblocked item and dispatch it with a receipt (issue URL + owner wake + worker session id), or verify a completion that landed (PR merged + live proof read back). " +
      'If you cannot act until something finishes, declare it: goal(action="wait", on="subagents" | "process" | "seconds" | "user"). If genuinely nothing changed and nothing is dispatchable, end quiet — no status post.',
  );
  return lines.join("\n");
}
