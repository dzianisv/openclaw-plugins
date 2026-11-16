/**
 * The push — feed a continuation prompt into the idle session as a new
 * agent turn. The push IS the wake.
 *
 * Route: `openclaw agent --agent <agentId> --session-key <sessionKey>
 * --message <continuation prompt> --timeout 300`. This is the proven
 * agentTurn route (the wake job uses it). It starts a new turn in the
 * idle session immediately — reactive, event-driven, no timer.
 *
 * Note: `api.session.workflow.enqueueNextTurnInjection` was NOT used for
 * the push: it only queues context for the NEXT turn and does not itself
 * start a turn in an idle session. The agentTurn message is what wakes it.
 */
import { execFile } from "node:child_process";

export interface PushOptions {
  cliPath: string;
  /** Seconds for the agentTurn CLI timeout (the new turn may take a while). */
  timeoutSeconds: number;
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
 * Push a continuation prompt into the session. Retries when the session
 * still has an active run (agent_end can fire mid-run — the same lesson as
 * failover-compact's compaction retry). Returns the CLI stdout on success.
 */
export async function pushContinuation(
  agentId: string,
  sessionKey: string,
  text: string,
  opts: PushOptions,
): Promise<{ ok: boolean; detail: string }> {
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
