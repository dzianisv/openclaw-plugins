/**
 * The Judge — a separate, cheap model call asking "is the goal DONE?".
 *
 * Route: `openclaw capability model run --agent <agentId> --model <judgeModel>
 * --prompt <prompt> --json`. A one-shot model turn, not a full agent turn.
 * The judge model is configurable; the built-in default is
 * openrouter/nvidia/nemotron-3.5-super-vl:free (free OpenRouter tier).
 *
 * Fallback chain (2026-11-20): a single-model judge dies on the first 429
 * — on 2026-11-19 the configured judge model (opencode-go/beam-free)
 * 429'd and every verdict came back judge_unavailable, so no goal could
 * complete, block, or resume on evidence. judgeGoal now tries the models
 * in order — configured judgeModel first, then each fallbackModels entry,
 * de-duplicated — and only reports a transport failure when EVERY model
 * fails. When no explicit fallback list is configured, the caller passes
 * the built-in default as the fallback, so a bad config override can
 * never strand a verdict. Parse failures are NOT retried on another
 * model: a model that answers with garbage is a verdict problem, not a
 * transport problem, and the fail-safe "continue" applies.
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
  /** Models tried in order after judgeModel when it fails on transport. */
  fallbackModels?: string[];
  cliPath: string;
  timeoutMs: number;
  /**
   * Test seam: when provided, replaces the CLI invocation for a model
   * (receives the model id, resolves the model's raw text). Production
   * never passes this.
   */
  runModel?: (model: string) => Promise<string>;
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

/** One judge attempt on one model via the openclaw CLI; throws on transport failure. */
async function runModelViaCli(opts: JudgeOptions, model: string, prompt: string): Promise<string> {
  const { stdout } = await runCli(
    opts.cliPath,
    [
      "capability", "model", "run",
      "--agent", opts.agentId,
      "--model", model,
      "--prompt", prompt,
      "--json",
    ],
    opts.timeoutMs,
  );
  return extractModelText(stdout);
}

export async function judgeGoal(input: JudgePromptInput, opts: JudgeOptions): Promise<JudgeResult> {
  const userPrompt = buildJudgeUserPrompt(input);
  const prompt = `${JUDGE_SYSTEM_PROMPT}\n\n${userPrompt}`;
  // Chain: configured judge model first, then each fallback in order,
  // de-duplicated — a model that 429s must never strand a verdict.
  const models: string[] = [];
  for (const m of [opts.judgeModel, ...(opts.fallbackModels ?? [])]) {
    const t = m.trim();
    if (t && !models.includes(t)) models.push(t);
  }
  const failures: string[] = [];
  for (const model of models) {
    let raw: string;
    try {
      raw = opts.runModel ? await opts.runModel(model) : await runModelViaCli(opts, model, prompt);
    } catch (err) {
      failures.push(`${model}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
      continue;
    }
    if (!raw.trim()) {
      failures.push(`${model}: empty output`);
      continue;
    }
    const parsed = parseJudgeResponse(raw);
    return { ...parsed, transportFailed: false, raw };
  }
  return {
    verdict: "continue",
    reason: `judge transport failed on every model (${failures.join(" | ") || "no models configured"})`,
    parseFailed: false,
    transportFailed: true,
    raw: "",
  };
}
