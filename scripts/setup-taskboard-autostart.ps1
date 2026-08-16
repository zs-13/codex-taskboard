# setup-taskboard-autostart.ps1 - Make the Codex Taskboard panel always available
#
# The Codex desktop app has no plugin API for embedding third-party sidebar
# panels, so the Taskboard panel is injected over Chrome DevTools Protocol and
# only exists in Codex windows that were launched with --remote-debugging-port
# (which the launcher does). That is why the panel disappears when Codex is
# reopened from its own icon and the injector is left waiting.
#
# This script turns that into a one-time setup so "open Codex -> panel is there"
# works again, with task history and live progress persisted:
#   1. Creates a desktop shortcut "Codex Taskboard" that opens the launcher
#      (service + Codex on a fixed CDP port + injector + agent runner).
#   2. Registers a logon autostart entry that keeps the resident injector ready
#      for that port, so the panel re-appears automatically whenever the
#      Taskboard-managed Codex window opens - no need to re-run the launcher.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/setup-taskboard-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/setup-taskboard-autostart.ps1 -Port 9232
#   powershell -ExecutionPolicy Bypass -File scripts/setup-taskboard-autostart.ps1 -SkipAutostart

param(
  [int]$Port = 9232,
  [switch]$SkipAutostart
)

$ErrorActionPreference = "Stop"

# Force UTF-8 on the console and in pipes to native commands so non-ASCII text
# (Chinese titles, paths, logs) is never re-encoded through the ANSI code page
# (GBK on zh-CN Windows) and turned into mojibake.
chcp 65001 > $null
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = Split-Path -Parent $PSScriptRoot
$launcherBat = Join-Path $repoRoot "scripts\start-taskboard.bat"
$injectorScript = Join-Path $repoRoot "scripts\codex-injector.mjs"
$iconPath = Join-Path $repoRoot "src-tauri\icons\icon.ico"

Write-Host "=== Codex Taskboard autostart setup ==="
Write-Host "Repo: $repoRoot"
Write-Host "CDP port: $Port"

# 1. Desktop shortcut that opens the Taskboard-managed Codex window.
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "Codex Taskboard.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcherBat
$shortcut.Arguments = "-Port $Port"
$shortcut.WorkingDirectory = $repoRoot
if (Test-Path $iconPath) { $shortcut.IconLocation = $iconPath }
$shortcut.Description = "Open Codex with the Taskboard sidebar panel (CDP port $Port)"
$shortcut.Save()
Write-Host "Created desktop shortcut: $shortcutPath"

# 2. Logon autostart keeps the resident injector ready on the fixed port so the
#    panel comes back automatically whenever that Codex window opens.
if (-not $SkipAutostart) {
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  $command = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command " +
    "`"Set-Location '$repoRoot'; node '$injectorScript' --daemon --open --port $Port`""
  Set-ItemProperty -Path $runKey -Name "CodexTaskboardInjector" -Value $command -Force
  Write-Host "Registered logon autostart for the Taskboard injector."
} else {
  Write-Host "Skipped logon autostart (-SkipAutostart)."
}

Write-Host ""
Write-Host "Done. Open 'Codex Taskboard' on the desktop to bring up the panel."
Write-Host "Task history and live progress persist in $repoRoot\.data\taskboard.sqlite."
