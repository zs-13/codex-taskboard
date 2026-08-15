#!/usr/bin/env node
// codex-plugin-install.mjs - cross-platform dispatcher for the "安装为 Codex 插件" action.
// On Windows it delegates to install-codex-plugin.ps1; elsewhere to
// install-codex-plugin.sh. Uses the checked-out repo (no clone needed) by
// pointing the local marketplace entry straight at the current directory.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

const command = isWindows
  ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "install-codex-plugin.ps1"), "-SkipClone"]]
  : ["bash", [path.join(root, "scripts", "install-codex-plugin.sh")]];

// For a checked-out repo we already ARE the plugin; adjust the personal
// marketplace entry to point at this directory rather than cloning.
// Set on every platform so the Windows PowerShell branch (install-codex-plugin.ps1
// -SkipClone) also resolves the marketplace path to this repo instead of a
// non-existent ~/.codex/plugins/codex-taskboard clone.
process.env.CODEX_PLUGIN_LOCAL_PATH = root;

const child = spawn(command[0], command[1], {
  cwd: root,
  stdio: "inherit",
  shell: isWindows ? false : false,
});
child.on("exit", (code) => process.exit(code ?? 0));
