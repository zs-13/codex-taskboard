# taskboard-processes.ps1 - Shared helpers for identifying the processes the
# Codex Taskboard launcher manages, used by start-taskboard.ps1 and
# stop-taskboard.ps1.
#
# Dot-source this file from a script that has already defined $repoRoot,
# $dataDir and $Port in its own scope:
#
#   . (Join-Path $PSScriptRoot "taskboard-processes.ps1")
#
# The identification criteria mirror codex-injector.mjs:
#   - a managed Codex main process is ChatGPT.exe carrying the launcher
#     --user-data-dir=... profile WITHOUT a --type= child-process marker;
#   - child processes of the same window inherit the profile flag and are
#     cleaned up together with the main process;
#   - background node processes are matched by their script path, and the
#     resident CDP injector additionally by the launcher CDP port.

function Test-HttpOk($url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Wait-HttpOk($url, $seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-HttpOk $url) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

# The launcher-profile directories used to recognise "our" Codex instances.
# start-taskboard.ps1 launches with <repoRoot>\.data\codex-profile; the resident
# injector's --open mode uses %LOCALAPPDATA%\CodexTaskboard\codex-profile. Both
# are dedicated launcher profiles, so either one is safe to clean up without
# touching Codex windows the user opened from the Start menu or app icon.
function Get-LauncherProfiles {
  $profiles = @((Join-Path $dataDir "codex-profile"))
  if ($env:LOCALAPPDATA) {
    $profiles += (Join-Path $env:LOCALAPPDATA "CodexTaskboard\codex-profile")
  }
  return $profiles
}

# All ChatGPT.exe processes carrying one of the launcher profiles (the main
# browser process plus its child processes).
function Get-ManagedCodexProcesses {
  $profiles = @(Get-LauncherProfiles)
  $processes = Get-CimInstance Win32_Process -Filter "name = 'ChatGPT.exe'" -ErrorAction SilentlyContinue
  foreach ($process in $processes) {
    $commandLine = [string]$process.CommandLine
    foreach ($profile in $profiles) {
      if ($commandLine.Contains("--user-data-dir=$profile")) {
        $process
        break
      }
    }
  }
}

# The main browser process among the managed Codex processes: it carries
# --user-data-dir without a --type= child-process marker. Mirrors
# windowsManagedCodexProcesses in codex-injector.mjs.
function Get-ManagedCodexMainProcess {
  Get-ManagedCodexProcesses | Where-Object {
    -not ([string]$_.CommandLine).Contains(" --type=")
  }
}

# True when the CDP endpoint reports at least one page target, i.e. a Codex
# window is actually open. An orphaned main process that survives a closed
# window keeps /json/version reachable but exposes no page targets.
function Test-CdpWindowOpen($port) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 2
    $targets = @($response.Content | ConvertFrom-Json)
    foreach ($target in $targets) {
      if ($target.type -eq "page") { return $true }
    }
    return $false
  } catch {
    # Cannot inspect targets (e.g. a non-browser listener). Assume a window is
    # open so we never kill a healthy instance we cannot inspect.
    return $true
  }
}

# The background node processes this launcher runs: the resident CDP injector
# (scoped to the launcher CDP port), the agent runner, and the Taskboard
# service. Mirrors the process matching used across the launcher scripts.
function Get-TaskboardNodeProcesses {
  $processes = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" -ErrorAction SilentlyContinue
  foreach ($process in $processes) {
    $commandLine = [string]$process.CommandLine
    $isInjector = $commandLine.Contains("codex-injector.mjs")
    if ($isInjector) {
      if (-not ($commandLine -match "--port[= ]$Port(?:\s|$)")) { continue }
    }
    $isRunner = $commandLine.Contains("taskboard-agent-runner.mjs")
    $isServer = $commandLine.Contains("server\index.mjs") -or $commandLine.Contains("server/index.mjs")
    if ($isInjector -or $isRunner -or $isServer) { $process }
  }
}

function Wait-ProcessGone($processId) {
  $deadline = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 200
  }
}

# Kill the managed Codex processes (main + children using a launcher profile)
# and wait for the CDP port to free up so a fresh launch can bind it.
function Stop-ManagedCodex([string]$cdpUrl = "http://127.0.0.1:$Port/json/version") {
  $processes = @(Get-ManagedCodexProcesses)
  if ($processes.Count -eq 0) {
    Write-Host "  no managed Codex processes running."
    return
  }
  foreach ($process in $processes) {
    Write-Host "  stopping ChatGPT.exe (PID $($process.ProcessId))."
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    Wait-ProcessGone $process.ProcessId
  }
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline -and (Test-HttpOk $cdpUrl)) {
    Start-Sleep -Milliseconds 250
  }
}

# Kill the background node processes (injector, agent runner, Taskboard
# service) this launcher started.
function Stop-TaskboardNodeProcesses {
  $processes = @(Get-TaskboardNodeProcesses)
  if ($processes.Count -eq 0) {
    Write-Host "  no managed node processes running."
    return
  }
  foreach ($process in $processes) {
    Write-Host "  stopping node.exe (PID $($process.ProcessId))."
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    Wait-ProcessGone $process.ProcessId
  }
}
