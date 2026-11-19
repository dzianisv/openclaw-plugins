/**
 * The push — feed a continuation prompt into the idle session as a new
 * agent turn. The push IS the wake.
 *
 * Default route (2026-11-19 rework): in-process, via the gateway plugin
 * API — `api.session.workflow.scheduleSessionTurn({ sessionKey, message,
 * delayMs: 0, tag: "goal-plugin" })`. The gateway Cron owns the turn from
 * there: it materializes the session if needed, runs the turn, and
 * records the run in Cron history. Scheduling is fire-and-forget — the
 * push returns once the turn is scheduled, not when it completes (the
 * CLI route blocked until turn end; nothing in the loop depended on
 * that, and blocking a background evaluation on a full agent turn was
 * the 900s-guillotine failure the 2026-11-19 audit found).
 *
 * Fallback route (pushRoute: "cli"): `openclaw agent --agent <agentId>
 * --session-key <sessionKey> --message <prompt> --timeout <s>` — the
 * original agentTurn subprocess, kept for hosts where the workflow API
 * is unavailable.
 *
 * Note: `api.session.workflow.enqueueNextTurnInjection` is still NOT
 * used for the push: it only queues context for the NEXT turn and does
 * not itself start a turn in an idle session. scheduleSessionTurn does.
 */
import { execFile } from "node:child_process";

/**
 * The in-process scheduling surface, injected by the plugin entry from
 * `api.session.workflow.scheduleSessionTurn`. Returns true when the turn
 * was scheduled (a job handle came back), false otherwise.
 */
export type ScheduleTurnFn = (args: {
  agentId: string;
  sessionKey: string;
  message: string;
}) => Promise<{ ok: boolean; detail: string }>;

export interface PushOptions {
  cliPath: string;
  /** Seconds for the agentTurn CLI timeout (CLI route only; the new turn may take a while). */
  timeoutSeconds: number;
  /** "api" (default): scheduleSessionTurn in-process. "cli": the openclaw agent subprocess. */
  route?: "api" | "cli";
  /** Injected scheduleSessionTurn wrapper; required for the api route. */
  scheduleTurn?: ScheduleTurnFn;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Push a continuation prompt into the session.
 *
 * API route: schedule the turn and return. CLI route: run the agentTurn
 * subprocess, retrying when the session still has an active run
 * (agent_end can fire mid-run — the same lesson as failover-compact's
 * compaction retry).
 */
export async function pushContinuation(
  agentId: string,
  sessionKey: string,
  text: string,
  opts: PushOptions,
): Promise<{ ok: boolean; detail: string }> {
  if (opts.route === "api") {
    if (!opts.scheduleTurn) {
      return { ok: false, detail: "pushRoute=api but scheduleSessionTurn is unavailable in this host" };
    }
    try {
      const r = await opts.scheduleTurn({ agentId, sessionKey, message: text });
      return { ok: r.ok, detail: r.detail.slice(0, 500) };
    } catch (err) {
      return { ok: false, detail: `scheduleSessionTurn failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) };
    }
  }
  const maxAttempts = 3;
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { stdout } = await runCli(
        opts.cliPath,
        [
          "agent",
          "--agent", agentId,
          "--session-key", sessionKey,
          "--message", text,
          "--timeout", String(opts.timeoutSeconds),
        ],
        (opts.timeoutSeconds + 60) * 1000,
      );
      return { ok: true, detail: stdout.slice(0, 500) };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const activeRun = /active run/i.test(lastError);
      if (activeRun && attempt < maxAttempts) {
        await sleep(10_000);
        continue;
      }
      return { ok: false, detail: lastError.slice(0, 500) };
    }
  }
  return { ok: false, detail: lastError.slice(0, 500) };
}
