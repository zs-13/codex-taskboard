// cli-tools.mjs - local CLI tool auto-detection
//
// Scans PATH plus common per-platform install locations for a configurable
// list of developer CLIs (claude / codex / cursor / gh / git / node / ...).
// The result is a lightweight Agent candidate list the squad UI can render
// ("我的工具 / Local tools"), and the authorization state is persisted so a
// tool can be enabled once and reused.
//
// The tool list is configurable:
//   - CODEX_TASKBOARD_CLI_TOOLS         comma-separated names (space-trimmed)
//   - CODEX_TASKBOARD_CLI_TOOLS_JSON    JSON array of names (takes precedence)
//   - Defaults: claude, codex, cursor, gh, git, node, npm, bun, python,
//     uv, docker, kubectl

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_CLI_TOOLS = [
  "claude",
  "codex",
  "cursor",
  "gh",
  "git",
  "node",
  "npm",
  "bun",
  "python",
  "uv",
  "docker",
  "kubectl",
];

const WINDOWS_EXECUTABLE_SUFFIXES = ["", ".exe", ".cmd", ".bat", ".ps1"];
const POSIX_EXECUTABLE_SUFFIXES = [""];

function configuredToolNames(env = process.env) {
  if (env.CODEX_TASKBOARD_CLI_TOOLS_JSON) {
    try {
      const parsed = JSON.parse(env.CODEX_TASKBOARD_CLI_TOOLS_JSON);
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry).trim()).filter(Boolean);
      }
    } catch {
      // fall through to the comma-separated list
    }
  }
  if (env.CODEX_TASKBOARD_CLI_TOOLS) {
    return env.CODEX_TASKBOARD_CLI_TOOLS.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [...DEFAULT_CLI_TOOLS];
}

function pathDirectories(env = process.env) {
  const directories = new Set();
  for (const entry of (env.PATH ?? "").split(path.delimiter)) {
    const trimmed = entry.trim();
    if (trimmed) directories.add(trimmed);
  }

  const home = os.homedir();
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    const appData = env.APPDATA ?? path.join(home, "AppData", "Roaming");
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    for (const directory of [
      path.join(localAppData, "Programs"),
      path.join(appData, "npm"),
      path.join(home, ".local", "bin"),
      path.join(programFiles, "nodejs"),
      path.join(home, "scoop", "shims"),
      path.join(localAppData, "Microsoft", "WindowsApps"),
    ]) {
      directories.add(directory);
    }
  } else {
    for (const directory of [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      path.join(home, ".local", "bin"),
      path.join(home, ".codex", "bin"),
      path.join(home, "bin"),
    ]) {
      directories.add(directory);
    }
  }
  return [...directories];
}

function executableCandidates(name, platform = process.platform) {
  const suffixes = platform === "win32"
    ? WINDOWS_EXECUTABLE_SUFFIXES
    : POSIX_EXECUTABLE_SUFFIXES;
  return suffixes.map((suffix) => `${name}${suffix}`);
}

function findExecutable(name, directories) {
  const candidates = executableCandidates(name);
  for (const directory of directories) {
    for (const candidate of candidates) {
      const fullPath = path.join(directory, candidate);
      if (existsSync(fullPath)) return fullPath;
    }
  }
  return null;
}

async function readVersion(executable) {
  for (const flag of ["--version", "-v", "version"]) {
    try {
      const { stdout } = await execFileAsync(executable, [flag], {
        timeout: 3_000,
        windowsHide: true,
      });
      const line = String(stdout ?? "").trim().split("\n")[0];
      if (line) return line.slice(0, 120);
    } catch {
      // try the next flag
    }
  }
  return null;
}

export async function scanCliTools({
  env = process.env,
  names = configuredToolNames(env),
  pathDirectoriesOverride,
} = {}) {
  const directories = pathDirectoriesOverride ?? pathDirectories(env);
  const results = [];
  for (const name of names) {
    const executable = findExecutable(name, directories);
    let version = null;
    if (executable) {
      try {
        version = await readVersion(executable);
      } catch {
        version = null;
      }
    }
    results.push({
      name,
      command: name,
      path: executable,
      version,
      installed: executable !== null,
    });
  }
  return results;
}
