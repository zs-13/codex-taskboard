#!/usr/bin/env bash
# install-codex-plugin.sh - Register codex-taskboard as a native Codex plugin (macOS/Linux)
#
# Goal: after running this, the Codex app shows "Codex Taskboard" under
# Plugins > Local Plugins (or a named marketplace), installable with one click,
# and its manage-taskboard skill becomes available to Codex agents.
#
# Strategy A: if the `codex` CLI is available, use the official
#   `codex plugin marketplace add zs-13/codex-taskboard` flow.
# Strategy B: otherwise register a personal marketplace at
#   ~/.agents/plugins/marketplace.json pointing at the plugin location.
#   - Normal run: clones the repo into ~/.codex/plugins/codex-taskboard.
#   - When CODEX_PLUGIN_LOCAL_PATH is set (checked-out repo / Codex action),
#     the marketplace entry points at that directory instead.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/zs-13/codex-taskboard.git}"
SKIP_CLONE="${SKIP_CLONE:-0}"
CODEX_PLUGIN_LOCAL_PATH="${CODEX_PLUGIN_LOCAL_PATH:-}"

HOME_DIR="${HOME}"
CODEX_HOME="$HOME_DIR/.codex"
PLUGINS_DIR="$CODEX_HOME/plugins"
PLUGIN_DIR="${CODEX_PLUGIN_LOCAL_PATH:-$PLUGINS_DIR/codex-taskboard}"
AGENTS_PLUGINS_DIR="$HOME_DIR/.agents/plugins"
MARKETPLACE_FILE="$AGENTS_PLUGINS_DIR/marketplace.json"

echo "=== Install codex-taskboard as a native Codex plugin ==="
echo "Codex home: $CODEX_HOME"

# 1. Prefer the official CLI flow
if command -v codex >/dev/null 2>&1; then
  echo "codex CLI found - using official marketplace flow."
  codex plugin marketplace add "zs-13/codex-taskboard"
  echo "Marketplace registered. Install in the Codex app:"
  echo "  Plugins > codex-taskboard marketplace > install 'Codex Taskboard'"
  echo "or run:  codex plugin install codex-taskboard@codex-taskboard"
  exit 0
fi

# 2. Clone into ~/.codex/plugins unless we are already a checked-out repo
if [ -z "$CODEX_PLUGIN_LOCAL_PATH" ]; then
  if [ "$SKIP_CLONE" = "0" ] && [ ! -d "$PLUGIN_DIR/.codex-plugin" ]; then
    echo "Cloning $REPO_URL into $PLUGIN_DIR ..."
    mkdir -p "$PLUGINS_DIR"
    git clone --depth 1 "$REPO_URL" "$PLUGIN_DIR"
  elif [ -d "$PLUGIN_DIR/.codex-plugin" ]; then
    echo "Plugin already present at $PLUGIN_DIR"
  fi
else
  echo "Using checked-out plugin at $PLUGIN_DIR"
fi

# 3. Add/update the personal marketplace entry
mkdir -p "$AGENTS_PLUGINS_DIR"

# Use node to merge into the existing marketplace.json. It computes a
# home-relative source.path when the plugin lives under $HOME (matching the
# Codex personal-marketplace convention), else uses the absolute path.
NODE_MERGE=$(cat <<'JS'
const fs = require("fs");
const path = require("path");
const file = process.argv[1];
const pluginDir = process.argv[2];
const homeDir = process.argv[3] || require("os").homedir();
let sourcePath = pluginDir;
if (pluginDir.toLowerCase().startsWith(homeDir.toLowerCase())) {
  const rel = path.relative(homeDir, pluginDir);
  sourcePath = "./" + rel.split(path.sep).join("/");
}
let data;
try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
catch { data = { name: "local-plugins", interface: { displayName: "Local Plugins" }, plugins: [] }; }
data.plugins = (data.plugins || []).filter(p => p && p.name !== "codex-taskboard");
data.plugins.push({
  name: "codex-taskboard",
  source: { source: "local", path: sourcePath },
  policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
  category: "Productivity",
});
data.interface = data.interface || {};
data.interface.displayName = data.interface.displayName || "Local Plugins";
fs.writeFileSync(file, JSON.stringify(data, null, 2));
JS
)

if command -v node >/dev/null 2>&1; then
  node -e "$NODE_MERGE" "$MARKETPLACE_FILE" "$PLUGIN_DIR" "$HOME"
else
  # Fallback: rewrite (loses any other local plugin entries, but keeps ours).
  SOURCE_PATH="$PLUGIN_DIR"
  cat > "$MARKETPLACE_FILE" <<JSON
{
  "name": "local-plugins",
  "interface": { "displayName": "Local Plugins" },
  "plugins": [
    {
      "name": "codex-taskboard",
      "source": { "source": "local", "path": "$SOURCE_PATH" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
JSON
fi

echo "Personal marketplace updated: $MARKETPLACE_FILE"
echo ""
echo "=== Next steps ==="
echo "1. Fully quit and restart the Codex app."
echo "2. Open Plugins (sidebar) > Local Plugins."
echo "3. Install 'Codex Taskboard'."
echo "4. The manage-taskboard skill is now available. Launch the panel with:"
echo "     npm run codex        (or ./scripts/start-taskboard.sh on macOS)"
echo ""
echo "Done."
