# stop-taskboard.ps1 - Stop everything the Codex Taskboard launcher started.
#
# Kills the managed Codex (ChatGPT.exe) window(s) launched with the launcher
# profile and the background node processes (Taskboard service, resident CDP
# injector, agent runner) that scripts/start-taskboard.ps1 started. Safe to
# run even when nothing is running; exits 0 either way.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/stop-taskboard.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/stop-taskboard.ps1 -Port 9232
#   powershell -ExecutionPolicy Bypass -File scripts/stop-taskboard.ps1 -KeepCodex
#   powershell -ExecutionPolicy Bypass -File scripts/stop-taskboard.ps1 -KeepNode
#
# Params:
#   -Port      CDP debugging port used by the launcher (default 9232).
#   -KeepCodex Keep the Codex window open; only stop the background node
#              processes (service / injector / agent runner).
#   -KeepNode  Keep the background node processes; only stop the managed
#              Codex window.

param(
  [int]$Port = 9232,
  [switch]$KeepCodex,
  [switch]$KeepNode
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $repoRoot ".data"
$runtimeFile = Join-Path $dataDir "launcher-runtime.json"

if ($KeepCodex -and $KeepNode) {
  throw "Cannot combine -KeepCodex with -KeepNode (that would stop nothing)."
}

. (Join-Path $PSScriptRoot "taskboard-processes.ps1")

Write-Host "=== Codex Taskboard (Windows stop) ==="
Write-Host "Repo: $repoRoot"
Write-Host "CDP port: $Port"

# 1. Background node processes: Taskboard service, resident CDP injector,
#    agent runner. The service and agent runner are designed to outlive the
#    Codex window, so they are only stopped when a full stop is requested.
if (-not $KeepNode) {
  Write-Host "Stopping background node processes (service / injector / agent runner)..."
  Stop-TaskboardNodeProcesses
}

# 2. The managed Codex window and its child processes.
if (-not $KeepCodex) {
  Write-Host "Stopping managed Codex (ChatGPT.exe)..."
  Stop-ManagedCodex
}

# 3. The launcher runtime file is stale once the injector is stopped; remove it
#    so a later start does not see a dead runtime.
if (Test-Path $runtimeFile) {
  Remove-Item $runtimeFile -Force
  Write-Host "Removed stale runtime file: $runtimeFile"
}

# 4. Hint when a logon autostart would bring the injector back after reboot.
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
if (Test-Path $runKey -and (Get-Item -Path $runKey).Property -contains "CodexTaskboardInjector") {
  Write-Host "Note: logon autostart for the Taskboard injector is still registered."
  Write-Host "      Run scripts\setup-taskboard-autostart.ps1 -SkipAutostart or remove the"
  Write-Host "      'CodexTaskboardInjector' entry under HKCU Run to stop it coming back after reboot."
}

Write-Host ""
Write-Host "Done. Task Manager should no longer show this launcher's ChatGPT.exe or"
Write-Host "node processes. Run scripts\start-taskboard.bat again to reopen the panel."
