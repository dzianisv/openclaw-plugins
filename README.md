# openclaw-goal-plugin

Per-session goal ownership for OpenClaw: the agent declares its goal, a judge audits it at every turn-end, and an unreached goal pushes a continuation prompt into the idle session. Reactive, event-driven — no timer, no hourly poll. Plugin-first, no fork of OpenClaw core.

Two plugins in one repo (they share code — `goal-tool` imports the handler from `../goal-plugin/dist/`):

| Plugin | What it is |
|---|---|
| `goal-plugin/` (`goal`) | The turn-end Judge + push. `definePluginEntry`, `agent_end` hook. Owns the SQLite registry (`goal.db`), the Judge, the stall detector, the judge-outage pause, and the push. |
| `goal-tool/` (`goal-tool`) | The agent-facing `goal` tool. `defineToolPlugin` + `contracts.tools`. The runtime only exposes a tool to agents when it is declared this way — registering a tool at runtime inside a `definePluginEntry` does not make it visible (see `goal-plugin/BUILD-REPORT.md`). |

## Install

```sh
cd goal-plugin && npm install && npm run build
cd ../goal-tool && npm install && npm run build   # goal-plugin must be built first
openclaw plugins install --link /path/to/goal-plugin
openclaw plugins install --link /path/to/goal-tool
openclaw plugins list   # goal and goal-tool should both be loaded
```

No gateway restart needed for the first install (`plugins install --link` loads live). Config lives in `plugins.entries.goal` / `plugins.entries.goal-tool` in `openclaw.json` (see each `openclaw.plugin.json` for the schema). The Judge model defaults to `openai/gpt-6.1-sol`.

**Reloading:** do NOT use `openclaw plugins reload goal` (or `goal-tool`) to load new code. The plugin's background work (Judge ~60s, push minutes) keeps it "busy", and the plugin host only waits 5s to drain — the reload fails with "Previous plugin cleanup failed" and can leave the plugin retired. Load new code with a **gateway restart** instead. Restart AFTER the copy lands: a gateway that starts before the new `dist/` is in place loads the old code while `package.json` already shows the new version — check the loaded code (a live `goal(action="list")` call), not just the version number.

## The `goal` tool

`get` / `create` / `link` / `complete` / `wait` / `resume` / `clear`, plus the Muse-mirroring management actions `list` / `search` / `update` / `set_status` / `create_entry` / `update_entry` / `delete_entry` / `delete`. Full action table in `goal-plugin/README.md`.

- `create` takes the objective + the acceptance criteria the agent writes itself — that declaration IS the inference. `complete` runs the audit and refuses when the verdict is not DONE.
- Every action works on the **calling session's goal**, except `list` / `search`, which list goals for sessions of the **same agent id**. Another agent's goals are never exposed.
- A **user-set goal always wins**: the agent's `create` (replace), `update`, `set_status`, and `delete` on a user-set goal are refused. The user/operator changes it via `setUserGoal` / `scripts/goal-admin.mjs`.
- `delete` removes the row entirely — only for mistakes / explicit user request; requires `confirm=true`. Finished goals should use `set_status` completed instead, which keeps the row + history.
- Muse's `delete_briefing` has no OpenClaw equivalent and is intentionally not mirrored. Tracking is a separate surface and is not part of this plugin.

## Registry

SQLite `goal.db` in the OpenClaw state dir. One row per session, keyed to the session KEY (`agent:<id>:main`) — stable, survives compaction. The live goal state lives ONLY here, never in a file (no `GOAL_STATE.md`, no goal text in any `AGENTS.md` / `GOAL.md`). Each row also carries `entries`: dated progress notes `{id, title, current_state, description, effective_at}`, stored as JSON. DBs created before the `entries` column get it added on open.

## Operator

```sh
node goal-plugin/scripts/goal-admin.mjs set-user-goal <sessionKey> <agentId> "<objective>" "<acceptanceCriteria>" "<verification>" ["<userAsk>"]
node goal-plugin/scripts/goal-admin.mjs list
node goal-plugin/scripts/goal-admin.mjs search <query>
node goal-plugin/scripts/goal-admin.mjs get <sessionKey>
node goal-plugin/scripts/goal-admin.mjs clear <sessionKey>
```

## Tests

```sh
cd goal-plugin && npm test   # builds, then node --test test/*.test.mjs
```

18 tests (11 decision/registry/judge + 7 management actions). The Judge and push are exercised live, not in unit tests.

## Status

Built, loaded, and verified live on OpenClaw 2026.11.2 (see `goal-plugin/BUILD-REPORT.md`). 0.2.0 verified live 2026-11-16: `goal(get)` + `goal(list)` return the agent's goal; create-with-replace is refused for user-set goals; complete with weak evidence does not complete the goal; a push continuation turn was observed (Monica's turns_used 2→3 after her get turn). Note: OpenClaw 2026.11.2 already has built-in goal tools (`get_goal`, `create_goal`, `update_goal`) — if the custom `goal` tool still does not appear after a restart, pivot the tool surface to the built-ins and have the Judge read OpenClaw's session-goal store.

**Supervisor cron gotcha (verified 2026-11-16):** an `agentTurn` cron job with delivery mode `none` FAILS — the session-event lane dies in ~4s with "plugin delivery capability is no longer active" (and falls back to the free model first). Delivery must stay `announce`; keep the job quiet via its prompt ("end quietly, do not post a status update") and point the destination at a team channel, not the user's DM.

## License

MIT.
