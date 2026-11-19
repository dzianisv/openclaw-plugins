/**
 * Per-session serialization for turn-end evaluations (W16 race fix).
 *
 * The `agent_end` hook can fire several times within a minute for one
 * session (a tick + a push + a subagent return), and each evaluation runs
 * a ~60s judge call. Without serialization those evaluations overlap:
 * a pause written by one does not stop the others from pushing — and
 * charging turns — afterwards, because each works from the goal row it
 * read before its judge call (and `saveGoal` is a full-row upsert, so a
 * stale push-path save can even write `active` back over a pause).
 *
 * Observed 2026-11-19 08:31–08:41 WITA on Monica's session: six
 * evaluations in ~4 min, pushes logged 08:40:53 + 08:41:21 AFTER the
 * 08:39:48 pause, turns 11→13 on a paused goal.
 *
 * The queue chains one evaluation per session key; different sessions
 * still run in parallel (Tony never waits on Monica). A failing task
 * never poisons the chain — the next task for the session still runs.
 */
export class PerSessionQueue {
  private chains = new Map<string, Promise<void>>();

  /** Enqueue a task for a session; tasks for one session run one at a time, in order. */
  run(sessionKey: string, task: () => Promise<void>): void {
    const prev = this.chains.get(sessionKey) ?? Promise.resolve();
    // Run the task even if the previous one rejected; the stored chain
    // itself never rejects, so a failing task cannot poison later ones
    // (and nothing awaits the chain, so there is no unhandled rejection).
    const next = prev.then(task, task).then(
      () => {
        if (this.chains.get(sessionKey) === next) this.chains.delete(sessionKey);
      },
      () => {
        if (this.chains.get(sessionKey) === next) this.chains.delete(sessionKey);
      },
    );
    this.chains.set(sessionKey, next);
  }

  /** Sessions with a pending or running evaluation (diagnostics / tests). */
  get size(): number {
    return this.chains.size;
  }
}
