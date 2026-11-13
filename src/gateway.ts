/**
 * Gateway transport for failover-compact.
 *
 * The public plugin SDK (openclaw 2026.11.2) exposes no in-process
 * "request a compaction" call, so this plugin talks to its own gateway the
 * same way an operator would: through the local `openclaw` CLI, which
 * authenticates from the gateway's local config and needs no extra secret.
 * Both calls used here were verified against a live gateway:
 *
 *   openclaw gateway call sessions.list --params '{}' --json
 *     -> sessions[].key, sessions[].inputTokens
 *   openclaw gateway call sessions.compact --params '{"key": "<sessionKey>"}' --json
 *     -> compaction result for that session
 *
 * The CLI runs on the same host as the gateway (plugins run in-process),
 * so `openclaw` must be on PATH, or `cliPath` must point at the binary.
 */

import { execFile } from "node:child_process";

export interface GatewayCallOptions {
  cliPath: string;
  timeoutMs: number;
}

function runCli(
  cliPath: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
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

/**
 * Read a session's current input-token count from `sessions.list`.
 * Returns null when the session is not found or the count is unavailable.
 */
export async function getSessionInputTokens(
  sessionKey: string,
  opts: GatewayCallOptions,
): Promise<number | null> {
  const { stdout } = await runCli(
    opts.cliPath,
    ["gateway", "call", "sessions.list", "--params", "{}", "--json", "--timeout", "30000"],
    opts.timeoutMs,
  );
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null || !("sessions" in parsed)) {
    throw new Error("sessions.list returned an unexpected shape");
  }
  const sessions = (parsed as { sessions: unknown }).sessions;
  if (!Array.isArray(sessions)) {
    throw new Error("sessions.list returned a non-array sessions field");
  }
  for (const entry of sessions) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      (entry as { key?: unknown }).key === sessionKey
    ) {
      const tokens = (entry as { inputTokens?: unknown }).inputTokens;
      return typeof tokens === "number" ? tokens : null;
    }
  }
  return null;
}

/** Trigger a compaction of one session. Returns the gateway's raw reply. */
export async function compactSession(
  sessionKey: string,
  opts: GatewayCallOptions,
): Promise<string> {
  const { stdout } = await runCli(
    opts.cliPath,
    [
      "gateway",
      "call",
      "sessions.compact",
      "--params",
      JSON.stringify({ key: sessionKey }),
      "--json",
      // The CLI's gateway timeout defaults to 10s; a real compaction is a
      // model call on a huge session and takes far longer. Without this the
      // CLI gives up while the gateway is still compacting.
      "--timeout",
      "600000",
    ],
    opts.timeoutMs,
  );
  return stdout;
}
