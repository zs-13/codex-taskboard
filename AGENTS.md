# Codex Taskboard — agent notes

## Quick install / 快速安装

Install and launch the Codex Taskboard from GitHub:

```bash
git clone https://github.com/zs-13/codex-taskboard
cd codex-taskboard
npm install
npm run codex
```

`npm run codex` works on **Windows and macOS**: it starts the local Taskboard
service, launches the official Codex app with a dedicated CDP port, injects the
Taskboard sidebar panel, and keeps the agent runner alive.

Platform shortcuts (same effect as `npm run codex`):

- **Windows:** `scripts\start-taskboard.bat`
- **macOS:** `./scripts/start-taskboard.sh`

Optional — install as a native Codex plugin (appears under Plugins > Local Plugins):

- **Windows:** `scripts\install-codex-plugin.bat`
- **macOS:** `./scripts/install-codex-plugin.sh`

When the panel is running, the local service URL is
<http://127.0.0.1:47823> (default), and the in-Codex panel opens in the
injected sidebar. `npm run codex` prints the exact address on startup.

## Native Codex plugin

This repository is a valid **Codex plugin**:

- Plugin manifest: `.codex-plugin/plugin.json`
- Repo-scoped marketplace: `.agents/plugins/marketplace.json`
- Bundled skill: `skills/manage-taskboard`

To register it as a native plugin from the app or CLI:

```bash
codex plugin marketplace add zs-13/codex-taskboard
codex plugin install codex-taskboard@codex-taskboard
```

or run the repo's own installer (`npm run codex:plugin:install`, or
`scripts/install-codex-plugin.bat` / `.sh`) which registers a personal
marketplace at `~/.agents/plugins/marketplace.json` when the CLI is absent.
After restarting Codex, the plugin appears under **Plugins > Local Plugins**,
installs with one click, and its `manage-taskboard` skill becomes available.
The sidebar panel itself is still rendered by the CDP injector (`npm run codex`).

## Running the Taskboard

- **Windows:** `scripts\start-taskboard.bat` or `npm run codex:windows` — launches the Codex app on CDP port `9232`, starts the local service, injects the panel, and runs the agent runner.
- **macOS:** `./scripts/start-taskboard.sh` or `npm run codex` — same flow on CDP port `9231`.
- **Just the service:** `npm start` serves the built UI on <http://127.0.0.1:47823>.
- The runtime SQLite database lives in `.data/` (gitignored).

## Common pitfalls (panel, instances, data)

- The sidebar panel is **not a native plugin panel**; it is injected over CDP into
  a Codex window launched with `--remote-debugging-port`. Opening Codex from the
  app icon does not enable CDP, so the panel will not appear — always open it via
  the launcher (`scripts\start-taskboard.bat` on Windows, `npm run codex` /
  `./scripts/start-taskboard.sh` on macOS).
- Closing and reopening Codex clears the panel; the resident injector re-attaches
  automatically once a debuggable Codex reappears on its port (reopen via the
  launcher, not the icon).
- Run exactly one Taskboard. Each distinct CDP port/profile creates another Codex
  window, injector, and service with its own `.data/taskboard.sqlite`, splitting
  task history. The launcher is idempotent; reuse the same port (Windows `9232`,
  macOS `9231`).
- The service and agent runner keep running when Codex closes on purpose (that is
  what powers real-time progress). Closing Codex does not delete tasks.
- Many `ChatGPT.exe`/`codex` entries in Task Manager is expected, not a bug: the
  Codex desktop app is Chromium-based, so one window runs as a main process plus
  GPU/network/storage/crashpad/renderer helpers that share the process name.
  Exactly one window = exactly one main `ChatGPT.exe` with no `--type=` marker.
- Windows one-click setup: `scripts\setup-taskboard-autostart.ps1` creates a
  "Codex Taskboard" desktop shortcut and a logon autostart for the injector.

# Project Development Rules

For feature work in this repository, use this order:

1. Before implementation, prove the real operation path to the user: entry point → user or agent action → data change or other side effect → observable result. Cite the actual component, API, and file involved, or demonstrate the path in the product. This proof is not a test.
2. Implement the requested main path with the smallest direct change that makes it work.
3. After implementation, demonstrate or verify only that direct operation path and give the result to the user for confirmation.
4. Before the user confirms the feature works, do not proactively add guardrails, mutation or regression tests, legacy compatibility protection, defensive extensions, or speculative fallback behavior.
5. User confirmation does not automatically authorize that follow-up work. Add targeted protection or tests only when the user explicitly asks for them, or when the user reports a concrete failure scenario that requires them.

The primary objective is to make the requested function work. Focus on the feature implementation itself and avoid over-design; safety, guardrails, and testing must not dominate the work or turn the feature into a surrounding engineering project. This rule supersedes the earlier standing instruction that every feature must be developed test-first. Test-first language in older issues does not apply unless the user restates it for that issue after this rule.

This ordering does not waive higher-priority safety or security requirements. Keep validation that is necessary at real external boundaries, such as user input or external APIs, but do not expand it into hypothetical protection beyond the requested path.
