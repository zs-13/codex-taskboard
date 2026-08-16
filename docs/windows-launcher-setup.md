# Windows launcher layout (build your own)

The repository ships **generic** Windows launchers — `scripts\start-taskboard.bat`
/ `scripts\stop-taskboard.bat` and their `.ps1` counterparts — that work from any
clone. This page explains how they are laid out, so you can build your own
one-click launcher (a desktop shortcut, a logon autostart entry, or a personal
script) without copying machine-specific paths, tokens, or secrets into a shared
repository.

## The pieces

One Taskboard instance is made of a few cooperating processes:

| Component | Script | Role |
| --- | --- | --- |
| Start launcher | `scripts\start-taskboard.bat` → `start-taskboard.ps1` | Install npm dependencies when missing, launch Codex with a dedicated CDP port, start the resident injector and the agent runner, wait for the service runtime file |
| Stop launcher | `scripts\stop-taskboard.bat` → `stop-taskboard.ps1` | Stop the launcher-managed Codex window and the background node processes (service / injector / agent runner), and remove the stale runtime file |
| Local service | `server/index.mjs` | The Taskboard HTTP API + UI (port `47823` by default) |
| Resident injector | `scripts\codex-injector.mjs` (launched with `--watch --open`) | Injects the sidebar panel over CDP, supervises the service, and writes `.data\launcher-runtime.json` |
| Agent runner | `scripts\taskboard-agent-runner.mjs` | Keeps agents alive so they can claim and execute issues |

`scripts\taskboard-processes.ps1` holds the shared process-identification
helpers both launchers use, so start and stop agree on exactly which
`ChatGPT.exe` / `node.exe` processes belong to the launcher profile.

## Start / stop contract

- **`start` is idempotent.** It only starts components that are not already
  running, so re-running it reuses the running service, injector, and Codex
  window instead of duplicating them.
- **`start -Force`** stops the managed Codex and the background node processes
  first, then starts everything fresh. Use it when a closed Codex window left a
  lingering process holding the CDP port.
- **`stop`** only targets the launcher profile — Codex windows you opened from
  the Start menu / app icon are never touched. It also deletes the stale
  `.data\launcher-runtime.json` so a later start does not see a dead runtime.
  Optional flags: `-KeepCodex` (stop only the background node processes) and
  `-KeepNode` (stop only the managed Codex window).
- **`setup-taskboard-autostart.ps1`** (optional) creates a **Codex Taskboard**
  desktop shortcut and registers a logon autostart for the resident injector,
  so the panel is one click away after install and survives reboots.

## Isolation

Each instance is scoped by:

- **CDP port** (default `9232`) and a launcher-owned user-data profile under
  `.data\codex-profile`. Different ports produce different Codex windows,
  injectors, services, and SQLite files — so stick to one port per instance.
- **Instance token** (`CODEX_TASKBOARD_INSTANCE_TOKEN`) scopes the service URL
  path (`http://127.0.0.1:<port>/<token>`); the **instance secret**
  (`CODEX_TASKBOARD_INSTANCE_SECRET`) authenticates the local components to each
  other. Both are auto-generated per launch when unset — never hard-code them,
  and never commit them.

`.data\` (runtime state, SQLite, logs, profiles) is gitignored, so nothing
machine-specific or secret ends up in the repository.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_TASKBOARD_CODEX_APP_PATH` | auto-detected | Explicit path to the Codex / `ChatGPT.exe` app |
| `CODEX_TASKBOARD_INSTANCE_TOKEN` | random UUID | Instance token scoping the service URL path |
| `CODEX_TASKBOARD_INSTANCE_SECRET` | random 32-byte hex | Shared secret between local components |
| `CODEX_TASKBOARD_HOST` | `0.0.0.0` | HTTP bind address; use `127.0.0.1` to disable LAN access |
| `CODEX_TASKBOARD_PORT` | `47823` | Local HTTP port |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47823` | CLI API origin |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite data directory |

## Keeping the repository generic

A personal launcher often needs a specific Codex app path, a fixed port, or
per-instance credentials. Keep those in **your local** launcher — environment
variables, a desktop shortcut, or a machine-local script — never in the shared
repository. The repo only ships generic scripts and generic docs.
