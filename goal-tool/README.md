# goal-tool — the `goal` tool as a proper OpenClaw tool plugin

The agent-facing `goal` tool (`defineToolPlugin` + `contracts.tools`).

**Why a separate plugin:** the runtime only exposes a tool to agents when the tool is declared via `defineToolPlugin`. Registering a tool at runtime with `api.registerTool` inside a `definePluginEntry` does NOT make it visible — the factory is never called and the agent gets "Tool named `goal` is not available". So the tool lives here and the turn-end Judge + push live in the sibling `goal` plugin. Both share the same registry (`goal.db`) and the same handler (`handleGoalAction`, imported from `../goal-plugin/dist/`).

See the top-level `README.md` for install steps, the full action list, and the "do NOT use `plugins reload`" warning. Build `goal-plugin` first — this plugin imports its `dist/`.
