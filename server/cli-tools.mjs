// cli-tools.mjs - local CLI tool auto-detection
//
// Scans PATH plus common per-platform install locations for a configurable
// list of developer CLIs. The default list follows Multica's 20 agent CLI
// runtimes (claude / codex / cursor-agent / copilot / opencode / openclaw /
// hermes / pi / agy / codebuddy / deveco / grok / kimi / kiro-cli / qodercli /
// qoderclicn / qwen / qwenpaw / reasonix / traecli) plus gh and other common
// dev tools. The result is a lightweight Agent candidate list the squad UI can
// render ("我的工具 / Local tools").
//
// Each tool reports:
//   - installed: true when an executable is found on PATH / known dirs
//   - signedIn:  three-state login status for the frontend to guide the user:
//       true  = installed and signed in (ready to run)
//       false = installed but not signed in (show "点这里打开它登录")
//       null  = not installed, or login state is not applicable / unknown
//   - authorized: persisted one-time consent (separate from login)
//
// The tool list is configurable:
//   - CODEX_TASKBOARD_CLI_TOOLS         comma-separated names (space-trimmed)
//   - CODEX_TASKBOARD_CLI_TOOLS_JSON    JSON array of names (takes precedence)
//   - Defaults: the Multica 20 runtimes + gh/git/node/npm/bun/python/uv/docker/kubectl

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Multica's 20 agent CLI runtimes (see github.com/zs-13/multica
// scripts/agent-cli-command-names.txt), plus gh and common dev tools.
export const MULTICA_RUNTIMES = [
  "claude",
  "codex",
  "cursor-agent",
  "copilot",
  "opencode",
  "openclaw",
  "hermes",
  "pi",
  "agy",
  "codebuddy",
  "deveco",
  "grok",
  "kimi",
  "kiro-cli",
  "qodercli",
  "qoderclicn",
  "qwen",
  "qwenpaw",
  "reasonix",
  "traecli",
];

export const DEFAULT_CLI_TOOLS = [
  ...MULTICA_RUNTIMES,
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

// Tools that are usable without an account login (version control, runtimes,
// package managers, container/kubernetes CLIs). When installed these report
// signedIn: true so the UI shows them as ready.
const NO_LOGIN_TOOLS = new Set([
  "git",
  "node",
  "npm",
  "bun",
  "python",
  "uv",
  "docker",
  "kubectl",
  "gh",
]);

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
      path.join(programFiles, "Git", "cmd"),
      path.join(programFiles, "Git", "bin"),
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

function readJsonIfPresent(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// Login probes for agent CLIs where a well-known auth artifact exists.
// Returning `false` means "installed but not signed in" (frontend shows the
// login guidance). Returning `null` means login state is unknown for this
// tool. Tools without an entry default to `null` (unknown) unless they are in
// NO_LOGIN_TOOLS.
function probeClaudeSignedIn(env, home) {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return true;
  const credentials = readJsonIfPresent(path.join(home, ".claude", ".credentials.json"));
  if (!credentials) return false;
  if (credentials.oauthAccount) return true;
  if (credentials.primaryApiKey) return true;
  if (credentials.customApiKeyResponses && Object.keys(credentials.customApiKeyResponses).length > 0) return true;
  return false;
}

function probeCodexSignedIn(env, home) {
  if (env.OPENAI_API_KEY || env.CODEX_API_KEY) return true;
  const auth = readJsonIfPresent(path.join(home, ".codex", "auth.json"));
  return auth ? true : false;
}

function probeGhSignedIn(env, home) {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return true;
  if (process.platform === "win32") {
    const hosts = readJsonIfPresent(path.join(home, ".config", "gh", "hosts.yml"));
    // gh stores hosts.yml as YAML; a non-trivial file with a token means signed in.
    return hosts ? true : false;
  }
  return existsSync(path.join(home, ".config", "gh", "hosts.yml")) ? true : false;
}

function probeCopilotSignedIn(env, home) {
  const hosts = readJsonIfPresent(path.join(home, ".config", "github-copilot", "hosts.json"));
  if (!hosts) return false;
  const entry = hosts["github.com"];
  return Boolean(entry && (entry.oauth_token || entry.token));
}

function probeOpenCodeSignedIn(env, home) {
  const auth = readJsonIfPresent(path.join(home, ".local", "share", "opencode", "auth.json"));
  if (!auth) return false;
  return Object.keys(auth).length > 0;
}

const SIGNED_IN_PROBES = {
  claude: probeClaudeSignedIn,
  codex: probeCodexSignedIn,
  gh: probeGhSignedIn,
  copilot: probeCopilotSignedIn,
  opencode: probeOpenCodeSignedIn,
};

function resolveSignedIn(name, env, home) {
  if (NO_LOGIN_TOOLS.has(name)) return true;
  const probe = SIGNED_IN_PROBES[name];
  if (!probe) return null;
  try {
    return probe(env, home);
  } catch {
    return null;
  }
}

export async function scanCliTools({
  env = process.env,
  names = configuredToolNames(env),
  pathDirectoriesOverride,
} = {}) {
  const directories = pathDirectoriesOverride ?? pathDirectories(env);
  const home = os.homedir();
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
      signedIn: executable ? resolveSignedIn(name, env, home) : null,
    });
  }
  return results;
}
