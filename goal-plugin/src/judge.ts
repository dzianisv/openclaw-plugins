/**
 * The Judge — a separate, cheap model call asking "is the goal DONE?".
 *
 * Route: `openclaw capability model run --agent <agentId> --model <judgeModel>
 * --prompt <prompt> --json`. A one-shot model turn, not a full agent turn.
 * The judge model is configurable; default is the agent's primary model
 * (openai/gpt-6.1-sol) because the free cheap model (opencode-go
 * deepseek-v4.1-flash) is monthly-limit-exhausted until ~Dec 3, 2026, and
 * the OpenRouter fallback 429s. The judge call is short (small prompt),
 * so it is cheap in tokens even on the primary. Switch judgeModel to
 * deepseek when its monthly limit resets.
 *
 * Transport errors (CLI failure, 429, timeout) set transportFailed and
 * fail-open to "continue" — but the caller counts consecutive failures and
 * pauses the goal after N (Hermes bug 3 fix: never run an unaudited goal
 * forever).
 */
import { execFile } from "node:child_process";
import { buildJudgeUserPrompt, JUDGE_SYSTEM_PROMPT, type JudgePromptInput } from "./prompts.js";

export type JudgeVerdict = "done" | "blocked" | "continue" | "wait" | "skipped";

export interface JudgeResult {
  verdict: JudgeVerdict;
  reason: string;
  parseFailed: boolean;
  /** For blocked: "transient" | "human_only". For wait: seconds. */
  blocker?: string;
  humanCategory?: string;
  humanDecision?: string;
  waitForSeconds?: number;
  transportFailed: boolean;
  raw: string;
}

export interface JudgeOptions {
  agentId: string;
  judgeModel: string;
  cliPath: string;
  timeoutMs: number;
}

function runCli(cliPath: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cliPath, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`openclaw CLI failed: ${err.message}. stderr: ${String(stderr).slice(0, 500)}`));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Extract the model's text from the CLI --json output (or raw output). */
function extractModelText(stdout: string): string {
  const trimmed = stdout.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      const p = parsed as { ok?: unknown; outputs?: unknown };
      if (p.ok === true && Array.isArray(p.outputs) && p.outputs.length > 0) {
        const first = p.outputs[0] as { text?: unknown };
        if (typeof first.text === "string") return first.text;
      }
      if (p.ok === false) {
        const err = (parsed as { error?: { message?: unknown } }).error;
        throw new Error(typeof err?.message === "string" ? err.message : "model call failed");
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message !== "model call failed" && !trimmed.startsWith("{")) throw e;
    // Not JSON — fall through to raw-text handling.
    if (trimmed.startsWith("{") && trimmed.includes('"ok"')) throw new Error("model call failed: unparseable CLI output");
  }
  // Raw (non-JSON) output: strip ANSI colour codes and log lines, keep the text.
  const noAnsi = trimmed.replace(/\u001b\[[0-9;]*m/g, "");
  const lines = noAnsi.split("\n").filter((l) => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith("[") && !t.startsWith("{") && !t.includes('"ok"');
  });
  return lines.join("\n").trim() || trimmed;
}

export function parseJudgeResponse(raw: string): {
  verdict: JudgeVerdict;
  reason: string;
  parseFailed: boolean;
  blocker?: string;
  humanCategory?: string;
  humanDecision?: string;
  waitForSeconds?: number;
} {
  const text = raw.trim();
  // Find a JSON object in the text (the model may wrap it in prose).
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { verdict: "continue", reason: "judge returned no JSON", parseFailed: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { verdict: "continue", reason: "judge JSON unparseable", parseFailed: true };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { verdict: "continue", reason: "judge JSON is not an object", parseFailed: true };
  }
  const p = parsed as Record<string, unknown>;
  // Legacy shape {"done": true/false}.
  if (typeof p.done === "boolean" && typeof p.verdict !== "string") {
    return {
      verdict: p.done ? "done" : "continue",
      reason: typeof p.reason === "string" ? p.reason : "",
      parseFailed: false,
    };
  }
  const verdictRaw = typeof p.verdict === "string" ? p.verdict.toLowerCase().trim() : "";
  const verdict: JudgeVerdict =
    verdictRaw === "done" || verdictRaw === "blocked" || verdictRaw === "continue" || verdictRaw === "wait"
      ? verdictRaw
      : "continue";
  const parseFailed = verdictRaw !== "done" && verdictRaw !== "blocked" && verdictRaw !== "continue" && verdictRaw !== "wait";
  return {
    verdict,
    reason: typeof p.reason === "string" ? p.reason : "",
    parseFailed,
    blocker: typeof p.blocker === "string" ? p.blocker : undefined,
    humanCategory: typeof p.human_category === "string" ? p.human_category : undefined,
    humanDecision: typeof p.human_decision === "string" ? p.human_decision : undefined,
    waitForSeconds: typeof p.wait_for_seconds === "number" ? p.wait_for_seconds : undefined,
  };
}

export async function judgeGoal(input: JudgePromptInput, opts: JudgeOptions): Promise<JudgeResult> {
  const userPrompt = buildJudgeUserPrompt(input);
  const prompt = `${JUDGE_SYSTEM_PROMPT}\n\n${userPrompt}`;
  let raw: string;
  try {
    const { stdout } = await runCli(
      opts.cliPath,
      [
        "capability", "model", "run",
        "--agent", opts.agentId,
        "--model", opts.judgeModel,
        "--prompt", prompt,
        "--json",
      ],
      opts.timeoutMs,
    );
    raw = extractModelText(stdout);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      verdict: "continue", reason: `judge error: ${reason}`,
      parseFailed: false, transportFailed: true, raw: "",
    };
  }
  if (!raw.trim()) {
    return {
      verdict: "continue", reason: "judge returned empty output",
      parseFailed: false, transportFailed: true, raw,
    };
  }
  const parsed = parseJudgeResponse(raw);
  return { ...parsed, transportFailed: false, raw };
}
