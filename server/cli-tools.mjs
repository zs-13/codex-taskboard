// cli-tools.mjs - local CLI tool auto-detection
//
// Scans PATH plus common per-platform install locations for a configurable
// list of Agent CLIs. The default list follows Multica's agent CLI runtimes
// (claude / codex / cursor-agent / copilot / opencode / openclaw / hermes /
// pi / agy / codebuddy / deveco / grok / kimi / kiro-cli / qodercli /
// qoderclicn / qwen / qwenpaw / reasonix / traecli) plus kilo / omp / multica.
// Only Agent CLIs are listed — general dev tools (git/node/npm/python/docker
// ...) are intentionally excluded so the "我的工具 / Local tools" panel stays
// a roster of task-capable agents, not a PATH dump.
//
// Each tool reports:
//   - installed: true when an executable is found on PATH / known dirs
//   - signedIn:  three-state login status for the frontend to guide the user:
//       true  = installed and signed in (ready to run)
//       false = installed but not signed in — the CLI exists but no login /
//               auth state was detected, so it cannot run tasks yet; the user
//               must sign in first (UI shows a clear explanation, not a bare
//               "已安装未登录")
//       null  = not installed, or login state is not applicable / unknown
//   - authorized: persisted one-time consent (separate from login)
//
// The tool list is configurable:
//   - CODEX_TASKBOARD_CLI_TOOLS         comma-separated names (space-trimmed)
//   - CODEX_TASKBOARD_CLI_TOOLS_JSON    JSON array of names (takes precedence)
//   - Defaults: the Multica agent runtimes + kilo/omp/multica

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Multica's 20 agent CLI runtimes (see github.com/zs-13/multica
// scripts/agent-cli-command-names.txt). These are the agent CLIs the squad
// panel treats as task-capable tools.
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

// Agent CLIs that aren't in the Multica 20 list but users install and expect
// to see: Kilo Code CLI, Oh-My-Pi, and the Multica CLI itself.
export const EXTRA_AGENT_CLIS = ["kilo", "omp", "multica"];

// The default scan scope is Agent CLIs only. General dev tools (git/node/npm/
// bun/python/uv/docker/kubectl) are deliberately NOT scanned — they can still
// be added via CODEX_TASKBOARD_CLI_TOOLS when a user explicitly configures one.
export const DEFAULT_CLI_TOOLS = [
  ...MULTICA_RUNTIMES,
  ...EXTRA_AGENT_CLIS,
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

function probeKiloSignedIn(env, home) {
  // Kilo Code CLI stores per-provider credentials in ~/.local/share/kilo/auth.json
  // (keyed by provider, e.g. { deepseek: { key }, kilo: { access } }) and an
  // account.json with an active account. Any non-empty credential entry means
  // the CLI is signed in.
  const auth = readJsonIfPresent(path.join(home, ".local", "share", "kilo", "auth.json"));
  if (auth) {
    const providers = Object.values(auth);
    if (providers.some((entry) => entry && (entry.key || entry.access || entry.token))) {
      return true;
    }
  }
  const account = readJsonIfPresent(path.join(home, ".local", "share", "kilo", "account.json"));
  if (account) {
    if (account.active) return true;
    if (account.accounts && Object.keys(account.accounts).length > 0) return true;
  }
  return false;
}

function probeMulticaSignedIn(env, home) {
  // The Multica CLI stores a per-workspace token at
  // ~/.multica/profiles/<workspace>/config.json.
  const profilesDir = path.join(home, ".multica", "profiles");
  if (!existsSync(profilesDir)) return false;
  try {
    for (const profile of readdirSync(profilesDir)) {
      const config = readJsonIfPresent(path.join(profilesDir, profile, "config.json"));
      if (config && typeof config.token === "string" && config.token) return true;
    }
  } catch {
    return false;
  }
  return false;
}

const SIGNED_IN_PROBES = {
  claude: probeClaudeSignedIn,
  codex: probeCodexSignedIn,
  gh: probeGhSignedIn,
  copilot: probeCopilotSignedIn,
  opencode: probeOpenCodeSignedIn,
  kilo: probeKiloSignedIn,
  multica: probeMulticaSignedIn,
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
