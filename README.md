# openclaw-failover-compact

An OpenClaw plugin that compacts a session automatically after a run fails
over to a fallback model — so the next run starts with a small prompt
instead of a bloated one.

No OpenClaw core code is changed. This is a native plugin, built on the
public plugin API (`definePluginEntry`, typed hooks).

## The problem

When the primary model dies (weekly usage limit, outage, billing), OpenClaw
falls back to another model — but the session prompt stays huge. In our case
the prompt was ~230k tokens. The fallback model then chokes on that prompt
too, every run fails the same way, and nothing ever shrinks the prompt,
because native auto-compaction only fires in two situations:

1. **Overflow recovery** — the model returns a context-overflow error.
2. **Threshold maintenance** — after a *successful* turn, when the session
   is past ~75% of the model's context window.

A 429 (billing) or 502 (upstream) is not an overflow error, and the turns
never succeed, so neither trigger ever runs. The prompt stays at 230k
forever.

This plugin closes that loop: a failed run that used a fallback triggers a
compaction, so the next run starts small.

## How it works

The plugin observes three hooks from the OpenClaw 2026.11.2 hook catalog:

| Hook | Role |
| --- | --- |
| `model_call_ended` | Records each model call's provider/model and whether it failed. |
| `before_model_resolve` | Records which model a turn is about to use (a fallback showing up here counts even if its call never completes). |
| `agent_end` | The decision point: after a run ends, decide whether to compact. |

A compaction fires only when **all** of these hold:

1. The run just ended in failure.
2. The primary model failed during the run, or a fallback model was used.
3. The session's input tokens (read from `sessions.list`) exceed
   `tokenThreshold` (default 100,000).
4. The per-session cooldown has elapsed (default 1 hour).

Compaction is requested through the gateway method `sessions.compact`, called
via the local `openclaw` CLI — the same call an operator would make by hand.
The public plugin SDK exposes no in-process "request a compaction" call, so
the CLI is the version-stable path; it authenticates from the gateway's local
config and needs no extra secret. The plugin runs in-process on the gateway
host, so `openclaw` must be on `PATH` (or set `cliPath`).

Compaction itself is a model call, and it runs through the session's
configured compaction model. **Set `agents.defaults.compaction.model` to a
model that actually works** — if it points at the dead primary, the
compaction 429s like everything else. See "Configuration" below.

Handlers never throw: a plugin error must never break an agent run.

## Install

Published plugins ship built JavaScript; a git checkout needs one build
first, and `plugins install` needs the gateway stopped (it requires
exclusive offline state ownership):

```bash
git clone https://github.com/dzianisv/openclaw-failover-compact.git
cd openclaw-failover-compact
npm install
npm run build            # produces dist/index.js
```

Stop the gateway, link-install the plugin, start the gateway again:

```bash
systemctl --user stop openclaw-gateway
openclaw plugins install --link ./openclaw-failover-compact --force
openclaw plugins enable failover-compact
systemctl --user start openclaw-gateway
```

Once the package is published to npm, the short form will be
`openclaw plugins install openclaw-failover-compact`.

Grant the plugin conversation-hook access in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "failover-compact": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

## Configuration

All of these live under `plugins.entries.failover-compact.config` in
`openclaw.json`. Every one is optional.

| Setting | Default | Meaning |
| --- | --- | --- |
| `primaryModel` | `agents.defaults.model.primary` | The model id that counts as "primary". |
| `fallbackModels` | `agents.defaults.model.fallbacks` | Model ids that count as fallbacks. |
| `tokenThreshold` | `100000` | Only compact when the session exceeds this many input tokens. |
| `cooldownMs` | `3600000` (1h) | Minimum time between two compactions of the same session. |
| `dryRun` | `false` | When `true`, log what would be compacted but do not compact. |
| `cliPath` | `"openclaw"` | Path to the `openclaw` binary used for gateway calls. |
| `enabledAgents` | `[]` (all) | Optional allowlist of agent ids to act on. |

**Compaction model (required for it to work at all):** set the model that
performs the compaction to one that is alive, e.g. your fallback:

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "model": "openrouter/dots-studio/dots-3-note-preview:free"
      }
    }
  }
}
```

Then restart the gateway. Compaction in safeguard mode summarizes the
transcript in chunks, so it can succeed where a full 230k-token turn cannot.

Verify the plugin loaded and its hooks registered:

```bash
openclaw plugins inspect failover-compact --runtime --json
```

## Verify it works

1. Install with `"dryRun": true` first.
2. Wait for (or force) a run where the primary fails and a fallback is used.
3. The gateway log shows `failover-compact: session <key>: DRY RUN — would
   compact (...)` with the reason.
4. Flip `dryRun` off, reload the plugin, and watch the next failed fallback
   run compact the session. Confirm with
   `openclaw gateway call sessions.list --params '{}' --json` — the session's
   `inputTokens` should drop.

## Development

```bash
npm install
npm test        # typecheck + build + unit tests (node:test)
npm run build   # tsc -> dist/
```

The decision logic (`src/decision.ts`) is pure — no I/O, no OpenClaw
imports — and is covered by `test/decision.test.mjs`.

## Compatibility

- OpenClaw `>= 2026.11.2` (developed and verified against 2026.11.2).
- Node 24.16+ / 26.1+ (per the OpenClaw plugin requirements).

## License

MIT
