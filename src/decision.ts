/**
 * Pure decision logic for failover-compact.
 *
 * A session is compacted only when ALL of these hold:
 *  1. the run just ended in failure (success === false),
 *  2. the primary model failed during the run, or a fallback model was used,
 *  3. the session's input tokens exceed the configured threshold,
 *  4. the per-session cooldown has elapsed.
 *
 * Keeping this pure (no I/O, no OpenClaw imports) makes it unit-testable
 * without a gateway.
 */

export interface CompactDecisionInput {
  /** The run just ended in failure. */
  runFailed: boolean;
  /** At least one model call to the primary model failed in this run. */
  primaryFailed: boolean;
  /** At least one model call in this run used a fallback model. */
  fallbackUsed: boolean;
  /** Current session input tokens (from `sessions.list`), or null if unknown. */
  inputTokens: number | null;
  /** Compact only when inputTokens exceeds this. */
  tokenThreshold: number;
  /** Epoch ms of the last compaction triggered for this session, or null. */
  lastCompactAt: number | null;
  /** Minimum ms between two compactions of the same session. */
  cooldownMs: number;
  /** Now, epoch ms (injectable for tests). */
  now: number;
}

export interface CompactDecision {
  compact: boolean;
  reason: string;
}

export function shouldCompact(input: CompactDecisionInput): CompactDecision {
  if (!input.runFailed) {
    return { compact: false, reason: "run succeeded; nothing to compact" };
  }
  if (!input.primaryFailed && !input.fallbackUsed) {
    return {
      compact: false,
      reason: "run failed but the primary model never failed and no fallback was used",
    };
  }
  if (input.inputTokens === null) {
    return { compact: false, reason: "session token count unknown; refusing to guess" };
  }
  if (input.inputTokens <= input.tokenThreshold) {
    return {
      compact: false,
      reason: `session is ${input.inputTokens} input tokens, under threshold ${input.tokenThreshold}`,
    };
  }
  if (input.lastCompactAt !== null && input.now - input.lastCompactAt < input.cooldownMs) {
    const remainingMs = input.cooldownMs - (input.now - input.lastCompactAt);
    return {
      compact: false,
      reason: `compacted ${Math.round((input.now - input.lastCompactAt) / 1000)}s ago; cooldown has ${Math.round(remainingMs / 1000)}s left`,
    };
  }
  const trigger = input.fallbackUsed
    ? "a fallback model ran after the primary failed"
    : "the primary model failed";
  return {
    compact: true,
    reason:
      `failed run, ${trigger}, session at ${input.inputTokens} input tokens ` +
      `(threshold ${input.tokenThreshold})`,
  };
}
