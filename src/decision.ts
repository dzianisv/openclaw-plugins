/**
 * Pure decision logic for failover-compact.
 *
 * A session is compacted only when ALL of these hold:
 *  1. a trigger fired for this run — a fallback model was observed
 *     (started or ended a call), a primary call failed, any call failed,
 *     or the run reported failure at agent_end,
 *  2. the session's input tokens exceed the configured threshold,
 *  3. the per-session cooldown has elapsed.
 *
 * The trigger is deliberately NOT "the run failed": agent_end.success is
 * true even when a run only produced an error reply, and a fallback call
 * can return 200 with no usable content. What matters is that a fallback
 * ran on an oversized session while the primary is dead — compacting then
 * is correct whether that particular run produced a reply or not.
 *
 * Keeping this pure (no I/O, no OpenClaw imports) makes it unit-testable
 * without a gateway.
 */

export interface CompactDecisionInput {
  /** A trigger fired for this run (see above). */
  trigger: boolean;
  /** Human-readable trigger description, for the audit log. */
  triggerDetail: string;
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
  if (!input.trigger) {
    return { compact: false, reason: "no failover trigger observed for this run" };
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
  return {
    compact: true,
    reason:
      `${input.triggerDetail}, session at ${input.inputTokens} input tokens ` +
      `(threshold ${input.tokenThreshold})`,
  };
}
