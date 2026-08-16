import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const startSource = await readFile(
  new URL("../scripts/start-taskboard.ps1", import.meta.url),
  "utf8",
);
const stopSource = await readFile(
  new URL("../scripts/stop-taskboard.ps1", import.meta.url),
  "utf8",
);
const stopBatSource = await readFile(
  new URL("../scripts/stop-taskboard.bat", import.meta.url),
  "utf8",
);
const helpersSource = await readFile(
  new URL("../scripts/taskboard-processes.ps1", import.meta.url),
  "utf8",
);
const injectorSource = await readFile(
  new URL("../scripts/codex-injector.mjs", import.meta.url),
  "utf8",
);

test("the Windows launcher can force-restart and cleans up orphaned Codex residue", () => {
  assert.match(startSource, /\[switch\]\$Force/);
  assert.match(startSource, /\. \(Join-Path \$PSScriptRoot "taskboard-processes\.ps1"\)/);
  // Orphan-port branch: CDP reachable but no managed Codex main process.
  assert.match(startSource, /CDP port \$Port is reachable but its managed Codex process is gone/);
  // Windowless-orphan branch: main process alive but no open window.
  assert.match(startSource, /has no open window\. Restarting it/);
  // Unknown-process safety: never kill a port owned by a non-managed process.
  assert.match(startSource, /already in use by an unknown process/);
});

test("the stop script kills managed Codex and the background node processes", () => {
  assert.match(stopSource, /\[switch\]\$KeepCodex/);
  assert.match(stopSource, /\[switch\]\$KeepNode/);
  assert.match(stopSource, /Stop-TaskboardNodeProcesses/);
  assert.match(stopSource, /Stop-ManagedCodex/);
  assert.match(stopSource, /launcher-runtime\.json/);
  assert.match(stopBatSource, /stop-taskboard\.ps1/);
});

test("shared process helpers reuse the injector's managed-Codex identification criteria", () => {
  assert.match(helpersSource, /function Get-LauncherProfiles/);
  assert.match(helpersSource, /function Get-ManagedCodexProcesses/);
  assert.match(helpersSource, /function Get-ManagedCodexMainProcess/);
  assert.match(helpersSource, /function Get-TaskboardNodeProcesses/);
  assert.match(helpersSource, /function Test-CdpWindowOpen/);
  assert.match(helpersSource, /function Stop-ManagedCodex/);
  assert.match(helpersSource, /function Stop-TaskboardNodeProcesses/);
  // The main-process test (no --type= child marker) mirrors
  // windowsManagedCodexProcesses in codex-injector.mjs.
  assert.match(helpersSource, /--user-data-dir=\$profile/);
  assert.match(helpersSource, /\.Contains\(" --type="\)/);
  assert.match(helpersSource, /codex-injector\.mjs/);
  assert.match(helpersSource, /taskboard-agent-runner\.mjs/);
  assert.match(helpersSource, /server\\index\.mjs/);
  // The injector's own recognition logic stays the source of truth.
  assert.match(injectorSource, /function windowsManagedCodexProcesses/);
  assert.match(injectorSource, /function managedCodexUsesPort/);
});
