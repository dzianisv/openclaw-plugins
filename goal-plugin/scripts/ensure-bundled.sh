#!/usr/bin/env bash
# ensure-bundled.sh — the goal plugin must live INSIDE the OpenClaw core
# package's bundled extensions dir, or core refuses its
# api.session.workflow.scheduleSessionTurn calls (registry gate:
# schedulePluginSessionTurn returns silently unless the plugin record's
# origin is "bundled"; origin is path-based — a plugin whose realpath is
# under <core>/dist/extensions is promoted to "bundled" at discovery).
#
# A core upgrade wipes dist/extensions. This script idempotently restores
# the bundled copies from the pristine source copies kept outside the
# core tree (~/.openclaw/goal-plugin-src, ~/.openclaw/goal-tool-src).
# Safe to run any time: it only acts when a bundled copy is missing.
set -euo pipefail

OC_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
EXT="${OPENCLAW_EXT_DIR:-$OC_HOME/runtime/node_modules/openclaw/dist/extensions}"

restore() {
  local name="$1" src="$2"
  local dst="$EXT/$name"
  if [ -f "$dst/dist/index.js" ]; then
    echo "ok: $name already bundled at $dst"
    return 0
  fi
  if [ ! -f "$src/dist/index.js" ]; then
    echo "ERROR: restore source $src has no dist/index.js" >&2
    return 1
  fi
  mkdir -p "$dst"
  rsync -a --exclude node_modules "$src/" "$dst/"
  # goal-tool needs its one runtime dependency (not in core's node_modules)
  if [ -d "$src/node_modules/typebox" ]; then
    mkdir -p "$dst/node_modules"
    rsync -a "$src/node_modules/typebox" "$dst/node_modules/"
  fi
  echo "restored: $name -> $dst"
}

restore goal-plugin "$OC_HOME/goal-plugin-src"
restore goal-tool "$OC_HOME/goal-tool-src"

# The gateway must load them from the bundled paths, or discovery assigns
# origin "config" and scheduleSessionTurn silently no-ops.
if ! grep -q "dist/extensions/goal-plugin" "$OC_HOME/openclaw.json"; then
  echo "WARN: openclaw.json plugins.load.paths does not point at dist/extensions/goal-plugin" >&2
fi
echo "ensure-bundled: done"
