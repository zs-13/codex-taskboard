[English](README.md) | [简体中文](README.zh-CN.md)

# Codex Taskboard

A local-first issue board that runs in a browser and can be embedded in Codex through the standalone CDP launcher or its injection script. The same HTTP API powers the React UI and the `taskctl` CLI used by the bundled Codex Skill.

![Codex window with the Taskboard panel embedded (real capture, panel open)](docs/assets/codex-sidebar-embedded.png)

## Screenshots

**议题看板 / Board** (with real office-work demo issues)

![Board view](docs/assets/taskboard-board.png)

**列表视图 / 甘特图 / 仪表盘**

| List | Gantt | Dashboard |
| --- | --- | --- |
| ![List](docs/assets/taskboard-list.png) | ![Gantt](docs/assets/taskboard-gantt.png) | ![Dashboard](docs/assets/taskboard-dashboard.png) |

**小队协作 / Squad** — 我的工具（本机 CLI 识别）、小组（队长路由）、派活、最近动静

| My tools | Groups | Assign | Activity |
| --- | --- | --- | --- |
| ![My tools](docs/assets/taskboard-squad-tools.png) | ![Groups](docs/assets/taskboard-squad-groups.png) | ![Assign](docs/assets/taskboard-squad-assign.png) | ![Activity](docs/assets/taskboard-squad-activity.png) |

## Quick start (install with Codex)

Clone the repository and launch the Taskboard with one command. The launcher installs npm dependencies when missing, starts the local Taskboard service, launches the official Codex app on a dedicated CDP port, injects the Taskboard sidebar entry, and keeps the agent runner alive so agents can claim and execute issues.

**Windows** (double-click, or run from a terminal):

```bat
git clone https://github.com/zs-13/codex-taskboard.git
cd codex-taskboard
scripts\start-taskboard.bat
```

Or run the PowerShell launcher directly:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-taskboard.ps1
```

The Codex app is auto-detected from the Microsoft Store install. If it is not found, pass `-CodexAppPath` or set `CODEX_TASKBOARD_CODEX_APP_PATH`.

**macOS**:

```bash
git clone https://github.com/zs-13/codex-taskboard.git
cd codex-taskboard
./scripts/start-taskboard.sh
```

Or use the built-in Codex action (`npm run codex`) which does the same on macOS:

```bash
npm run codex
```

**Open in Codex directly:** the repository ships a Codex environment action (`启动` / "Launch", in `.codex/environments/environment.toml`) that dispatches to the platform launcher (`scripts/codex-launch.mjs`). Open the cloned folder in the Codex app and click the action to start the panel.

> **Windows one-click setup (optional):** after cloning, run
> `scripts\setup-taskboard-autostart.ps1` to create a **Codex Taskboard** desktop
> shortcut and a logon autostart for the resident injector. From then on, open
> the panel by double-clicking that shortcut — no terminal needed. See
> [Keep the sidebar panel available](#keep-the-sidebar-panel-available-avoid-these-pitfalls)
> for the pitfalls this avoids.

## How to open the Taskboard panel (Windows / macOS)

The Taskboard panel lives in the **right sidebar of a Codex window the launcher started** — it is injected over CDP, so a Codex window opened from the app icon / Start menu will not show it. To see the panel, always open Codex through the launcher below.

**Windows**

1. Double-click `scripts\start-taskboard.bat` (or run it from a terminal):

   ```bat
   cd codex-taskboard
   scripts\start-taskboard.bat
   ```

   After the one-time setup, you can also double-click the **Codex Taskboard** desktop shortcut — see `scripts\setup-taskboard-autostart.ps1`.

2. A Codex window opens with the Taskboard panel in the right sidebar. The service and agent runner keep running in the background; closing the Codex window only closes the window, not the taskboard.

**macOS**

1. Run the launcher from a terminal:

   ```bash
   cd codex-taskboard
   ./scripts/start-taskboard.sh
   ```

   or the equivalent `npm run codex`, or the built-in Codex action `启动` / "Launch" after opening the folder in Codex.

2. A Codex window opens with the Taskboard panel in the right sidebar.

**How to use it**

- The panel is a full task board: create and move issues, switch between **看板 / 列表 / 甘特图 / 仪表盘**, and use the **小队** zone to organize agents, teams, and assign work.
- Agents (via the bundled `manage-taskboard` skill / `taskctl` CLI) claim and execute issues; progress and comments sync live.
- Data is stored locally (`.data/taskboard.sqlite` by default) and survives closing Codex. After a restart, reopen Codex through the same launcher command to bring the panel back.

If the panel does not appear, the most common cause is opening Codex from the app icon instead of the launcher — see [Keep the sidebar panel available](#keep-the-sidebar-panel-available-avoid-these-pitfalls).

## Install as a native Codex plugin

This repository is packaged as a **Codex plugin** (`.codex-plugin/plugin.json` + repo-scoped marketplace `.agents/plugins/marketplace.json`), so Codex can install it from the GitHub link and show it in the Plugins sidebar. The bundled `manage-taskboard` skill becomes available to Codex agents.

**Option A — official CLI (fastest):**

```bash
codex plugin marketplace add zs-13/codex-taskboard
codex plugin install codex-taskboard@codex-taskboard
```

Then restart the Codex app and the plugin appears under **Plugins**. The panel is launched separately with `npm run codex` (or the `启动` action).

**Option B — repo installer (no CLI needed):**

```bash
# Windows
scripts\install-codex-plugin.bat

# macOS
./scripts/install-codex-plugin.sh

# or the Codex environment action "安装为 Codex 插件" after opening the folder
npm run codex:plugin:install
```

This registers a personal marketplace at `~/.agents/plugins/marketplace.json` pointing at the plugin, then you restart Codex and install from **Plugins > Local Plugins**.

> Note: the Codex plugin format covers skills/MCP/apps. The Taskboard's interactive **sidebar panel** is rendered by the CDP injector (`npm run codex` / `scripts/start-taskboard.*`), which the plugin's skill instructs Codex to launch. The plugin makes the repository discoverable and installable as a first-class Codex extension.

> Windows uses CDP port `9232`, macOS uses `9231`. If a port is taken, override it: `scripts\start-taskboard.ps1 -Port 9231` or `CODEX_TASKBOARD_PORT=9231 ./scripts/start-taskboard.sh`.

## Requirements

- Node.js 22.5 or newer
- macOS App and DMG builds: Xcode Command Line Tools and Rust 1.88 or newer with the `aarch64-apple-darwin` and `x86_64-apple-darwin` targets. `npm install` installs the Tauri CLI used by this project.
- Windows NSIS builds: the Microsoft Store Codex App, Rust 1.88 or newer, and Visual Studio Build Tools with the C++ workload and Windows SDK.

## Run locally

```bash
npm install
npm run build
npm start
```

Open <http://127.0.0.1:47823>. The SQLite database is stored at `.data/taskboard.sqlite`.

## Local CLI tool auto-detection

The squad panel ("我的工具") scans this machine for installed developer CLIs and lists them as tool agents you can add to a squad. Detection follows Multica's 20 agent CLI runtimes (`claude`, `codex`, `cursor-agent`, `copilot`, `opencode`, `openclaw`, `hermes`, `pi`, `agy`, `codebuddy`, `deveco`, `grok`, `kimi`, `kiro-cli`, `qodercli`, `qoderclicn`, `qwen`, `qwenpaw`, `reasonix`, `traecli`) plus `gh`, `git`, `node`, `npm`, `bun`, `python`, `uv`, `docker`, `kubectl` by default, and is configurable:

```bash
# comma-separated list
CODEX_TASKBOARD_CLI_TOOLS="claude,codex,gh,npx" npm start

# or a JSON array
CODEX_TASKBOARD_CLI_TOOLS_JSON='["claude","codex","gh"]' npm start
```

The API is `GET /api/cli-tools` (scan result: name, command, path, version, installed, `signedIn` three-state true/false/null, authorized) and `POST /api/cli-tools/:name/authorize` / `.../revoke`. Tools that need a login report `signedIn: false` when installed-but-not-signed-in, so the panel can show a login prompt; not-installed tools report `null`. Authorized tools appear in the agent roster with `source: "cli"` and can join squads. The panel refreshes the scan when it opens and on demand.

For development with live frontend reload:

```bash
npm run dev
```

The Vite UI runs at <http://127.0.0.1:5173> and proxies API requests to the local service.

## Use the CLI

Run it from the project:

```bash
npm run taskctl -- project create \
  --id my-project \
  --name "My project" \
  --workspace-path /absolute/path/to/repository

npm run taskctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp
```

Use `npm link` if you want `taskctl` on your shell path. Set `CODEX_TASKBOARD_URL` to point the CLI at another local or LAN service. Cloud deployments are configured through the **loopback companion** (device-local loopback service for auth and path mapping—not a chat persona) with `taskctl cloud login`.

## Install the Codex Skill

Copy or symlink `skills/manage-taskboard` into the Codex skills directory, then start a new Codex task:

```bash
ln -s /absolute/path/to/codex-taskboard/skills/manage-taskboard \
  ~/.codex/skills/manage-taskboard
```

The Skill teaches Codex to inspect an issue, move it to `in_progress`, use optimistic versions, verify the work, and then move it to `in_review`; it moves the issue to `done` only after the user explicitly confirms acceptance or asks to mark it complete.

## Embed in Codex

### Manual: use a dedicated CDP port

Keep the existing Codex window open. From the Taskboard repository, start a second Codex instance with a dedicated CDP port:

```bash
open -n -a /Applications/ChatGPT.app --args \
  --remote-debugging-port=9231 \
  --remote-allow-origins=http://127.0.0.1:9231
```

After the new Codex window appears, run the injector in another terminal:

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 \
npm run codex:inject -- --port 9231 --open
```

Keep the injector terminal running while using the embedded panel. The original Codex window remains unchanged, and the new window receives the Taskboard sidebar entry. If port `9231` is occupied, use another port in both commands.

### Recommended: launch an independent Taskboard window with one command

Keep existing Codex windows open and run:

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

This starts the local Taskboard service when needed, launches the official macOS Codex app with an independent profile and loopback-only port `9231`, waits for the main renderer and sidebar, injects a native-looking Taskboard entry after Plugins, and keeps watching both the service and replacement renderers. Existing Codex windows remain unchanged. Keep this command running while using the embedded panel. The launcher does not modify `ChatGPT.app` or its `app.asar`.

The source launcher writes its authenticated endpoint to `.data/launcher-runtime.json`. A `taskctl` command installed with `npm link` reads this file by default, so a normal shell and a Codex task opened from the panel use the same Taskboard service without an extra environment variable.

### macOS App: open and inject without a terminal

For Tauri development, run:

```bash
npm run app:dev
```

To build the local App and DMG, install the two Rust targets once, then run the build:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run app:build
```

Open `src-tauri/target/universal-apple-darwin/release/bundle/macos/Codex Taskboard.app` from Finder. The DMG is in `src-tauri/target/universal-apple-darwin/release/bundle/dmg/`. If you only want the stable App, download the current DMG from [GitHub Releases](https://github.com/zs-13/codex-taskboard/releases/latest).

The App contains its own Node runtime, Taskboard service, built web UI, Skill, CLI wrapper, and injection script. It starts the service, launches the official Codex app, waits for the renderer, injects the sidebar entry, and opens the panel without showing a terminal window. The App can be copied away from this checkout; the target Mac only needs the official Codex app and does not need this repository, a system Node installation, or a separate Codex CLI installation. Taskboard data is stored in `~/Library/Application Support/Codex Taskboard`, and launcher output is written to `~/Library/Logs/Codex Taskboard/codex-taskboard-launcher.log`.

### Windows code signing

For official Windows releases after the application is approved: **Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).** Current Windows CI artifacts remain unsigned until that approval. See the [Code signing policy](docs/code-signing-policy.md), [Privacy policy](PRIVACY.md), and [Windows uninstall instructions](docs/windows-uninstall.md).

The local build uses ad-hoc code signing for direct verification. A public macOS download still needs Developer ID signing and Apple notarization.

### Windows App: tray launcher and bundled Taskboard

Install the official Codex App from the Microsoft Store. To build the current-user NSIS installer on Windows x64, run:

```powershell
npm ci
npm run app:build:windows
```

The installer is written to `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`. It installs a tray launcher, bundled Node runtime, local service, built web UI, Skill, `taskctl.cmd`, and injection script. Taskboard data is stored in `%APPDATA%\Codex Taskboard`; logs are stored in `%LOCALAPPDATA%\Codex Taskboard\Logs`; the Skill is copied to `%USERPROFILE%\.agents\skills\manage-taskboard`.

Windows CI artifacts are intentionally unsigned and do not auto-update. Review [the code-signing policy](docs/code-signing-policy.md) before distributing a build. See [Windows uninstall](docs/windows-uninstall.md) for retained-data behavior.

Codex 26.715.52143 ships a renderer CSP that blocks arbitrary HTTP iframes. The launcher therefore enables CDP CSP bypass, reloads that renderer once, installs the document-start script, and waits until the Taskboard OOPIF is actually loaded. CDP is unauthenticated to other processes on the same machine, so only run trusted local code while the launcher is active.

To inject into a Codex instance that was already launched with CDP by another method, run:

```bash
npm run codex:inject -- --port 9229 --open
```

This command also stays resident so the injected tab can restart Taskboard after a service exit. Stop it with `Ctrl-C`.

The script adds a Taskboard entry to the Codex sidebar and renders the iframe across Codex's complete main workspace, including the contextual titlebar area so Taskboard's own header does not leave an empty strip. That full rectangular header is placed above Electron's draggable layer and marked `no-drag`; because the native contextual actions are suppressed while Taskboard is active, its own actions use their normal edge padding without an artificial right-side gap. The native sidebar stays mounted, while the previous page selection and contextual header are temporarily suppressed; choosing another Codex page restores them.

“在对话中打开” selects the corresponding native Codex project when one is available and opens an unsent native composer with an `e-taskboard` instruction and the issue's actual identifier. The installed Skill is selected implicitly from that instruction, so the composer does not add a `$manage-taskboard` mention. A conversation is attributed only after it actually processes the issue: `taskctl` reads Codex's `CODEX_THREAD_ID` and records that ID on the issue or comment mutation. Recorded IDs are clickable through Codex's native route bridge. Each issue can bind either one Git branch or one worktree; the options are scanned from the selected Codex project's repository instead of being typed by hand. The integration uses Codex's existing project, composer, and route markers; it does not patch React, replace `fetch`, load private chunks, or edit Codex data files.

To use a different UI origin, set `window.__CODEX_TASKBOARD_URL__` before the user script runs.

## Keep the sidebar panel available (avoid these pitfalls)

The sidebar panel is **not a native Codex plugin panel** — the Codex plugin
format covers skills/MCP, not third-party sidebar embeds. The panel is injected
over Chrome DevTools Protocol (CDP) into a Codex window that the launcher started
with `--remote-debugging-port`. These are the things users hit most often, and
how to avoid them:

1. **Open Codex through the launcher, not the app icon.** A Codex window launched
   normally (Start menu / app icon) does not enable CDP, so the injector cannot
   attach and the panel never appears. Always open the panel's Codex window via
   `scripts\start-taskboard.bat` (Windows) or `./scripts/start-taskboard.sh` /
   `npm run codex` (macOS).

2. **Closing and reopening Codex clears the panel.** The panel lives inside the
   Codex window, so a restart removes it. The resident injector re-attaches
   automatically as soon as a debuggable Codex reappears on its port — reopen
   Codex through the launcher and the panel comes back on its own.

3. **Run exactly one Taskboard.** Do not launch with a different CDP port each
   time. Every distinct port/profile spawns another Codex window, another
   injector, and another service, each with its own `.data/taskboard.sqlite`, so
   history appears to "disappear" between instances. Stick to one port
   (Windows `9232`, macOS `9231`). The launcher is idempotent — re-running it
   reuses the running service, injector, and Codex instead of duplicating them.

4. **The service outlives Codex on purpose.** The service and agent runner keep
   running when Codex closes; that is what keeps task progress and history moving
   in real time. Closing Codex does not delete tasks. To stop everything, stop
   the service/injector/agent-runner processes or disable the logon autostart.

5. **One-click setup (Windows).** `scripts\setup-taskboard-autostart.ps1` creates
   a **Codex Taskboard** desktop shortcut (launcher on a fixed port) and registers
   a logon autostart for the resident injector, so the panel is one click away
   after install and survives reboots.

6. **Many `ChatGPT.exe` / `codex` entries in Task Manager is normal.** The Codex
   desktop app is built on Chromium, and a single window runs as a main browser
   process plus several helpers — GPU, network, storage, crash reporter, and one
   renderer per tab/panel. They all share the app name, so one Codex window shows
   up as 10+ entries in Task Manager. You have exactly one window when exactly one
   `ChatGPT.exe` carries the launcher flags *without* a `--type=` child-process
   marker (the main process: `--user-data-dir=... --remote-debugging-port=...`).
   The launcher additionally keeps a small set of `node.exe` background services
   (service, injector, agent runner) alive on purpose.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `0.0.0.0` | HTTP bind address; use `127.0.0.1` to disable LAN access |
| `CODEX_TASKBOARD_PORT` | `47823` | Local HTTP port |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite data directory |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47823` | CLI API origin |

`npm start` prints both the local URL and the available LAN URLs. Teammates on the same trusted network can open one of those LAN URLs and use the same taskboard service. Task, comment, and attachment changes are broadcast to every open client through server-sent events; reconnecting clients perform a full refresh so changes made while disconnected are not missed. A teammate using `taskctl` can point it at the shared service with `CODEX_TASKBOARD_URL=http://<host-ip>:47823`.

LAN mode has no account authentication: anyone on the trusted local network who can reach the URL can read and write the taskboard. Public internet and cloud deployment require an authenticated deployment boundary.

## Share through Cloudflare

For two trusted collaborators, the taskboard can run on Cloudflare with Worker Static Assets and API routes, D1 as the authoritative business database, and a private R2 bucket for attachments. The deployment uses HTTPS Basic Authentication with a shared password and refreshes open boards after a global revision changes.

Each device keeps its own project checkout mapping and continues to use a local companion for Codex, Git/worktree, Skill, and MCP capabilities. Cloud mode never falls back to or double-writes the local SQLite database.

See [Cloud collaboration](docs/cloud-collaboration.md) for owner deployment, existing GitHub installation setup, password rotation, local path mapping, and the one-time local-data migration flow.

## Verify

```bash
npm run check
```

This runs TypeScript checking, a production frontend build, the component tests, and the server/CLI/injection test suite.

## Task Markdown

Task descriptions and comments support GFM, including tables and task lists. Fenced `mermaid` blocks are rendered as read-only diagrams after the viewer loads; the diagram source remains available when rendering fails. Markdown HTML comments, such as `<!-- trace-analysis:v1 ... -->`, are hidden from the rendered document. Raw HTML is not enabled.
