#!/usr/bin/env node
// Cross-platform entry point used by the Codex environment action ("启动").
// The codex-injector --launch path relies on macOS LaunchServices (/usr/bin/open),
// so on Windows we route through the PowerShell launcher instead, which launches
// ChatGPT.exe directly with a dedicated CDP port.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

const command = isWindows
  ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "start-taskboard.ps1")]]
  : ["npm", ["run", "codex"]];

const child = spawn(command[0], command[1], {
  cwd: root,
  stdio: "inherit",
  shell: !isWindows,
});

child.on("exit", (code) => process.exit(code ?? 0));
