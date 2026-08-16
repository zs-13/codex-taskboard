# start-taskboard.ps1 - Windows launcher for Codex Taskboard
#
# Starts the local Taskboard service, launches the Codex (ChatGPT) app with a
# dedicated CDP port, injects the Taskboard sidebar entry, and keeps the agent
# runner alive. Safe to run repeatedly: it only starts components that are not
# already running. It also recovers from residual Codex processes: when the CDP
# port is reachable but the managed Codex process is gone (or its window was
# closed while the process lingered), it cleans up the residue and relaunches so
# a new window always opens.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/start-taskboard.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/start-taskboard.ps1 -Port 9232
#   powershell -ExecutionPolicy Bypass -File scripts/start-taskboard.ps1 -CodexAppPath "C:\...\ChatGPT.exe"
#   powershell -ExecutionPolicy Bypass -File scripts/start-taskboard.ps1 -Force
#
# Params:
#   -Port          CDP debugging port used for injection (default 9232).
#   -CodexAppPath  Explicit path to the Codex / ChatGPT.exe app. When omitted the
#                  script scans WindowsApps for an OpenAI.Codex install. You can
#                  also set the CODEX_TASKBOARD_CODEX_APP_PATH environment variable.
#   -Force         Stop the managed Codex (and background node processes) first,
#                  then start everything fresh. Use this when a closed Codex
#                  window left a lingering process holding the CDP port.

param(
  [int]$Port = 9232,
  [string]$CodexAppPath = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

# Force UTF-8 on the console and in pipes to native commands so non-ASCII text
# (Chinese titles, paths, logs) is never re-encoded through the ANSI code page
# (GBK on zh-CN Windows) and turned into mojibake.
chcp 65001 > $null
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $repoRoot ".data"
$logDir = Join-Path $dataDir "logs"
$runtimeFile = Join-Path $dataDir "launcher-runtime.json"
New-Item -ItemType Directory -Force $dataDir, $logDir | Out-Null

# Shared helpers: Test-HttpOk / Wait-HttpOk and the managed Codex / node
# process identification used for residue cleanup below.
. (Join-Path $PSScriptRoot "taskboard-processes.ps1")

function Has-NodeProcess($matchText, $portFilter = "") {
  $processes = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" -ErrorAction SilentlyContinue
  foreach ($process in $processes) {
    $commandLine = [string]$process.CommandLine
    if (-not $commandLine.Contains($matchText)) { continue }
    if ($portFilter -and -not $commandLine.Contains("--port $portFilter")) { continue }
    return $true
  }
  return $false
}

Write-Host "=== Codex Taskboard (Windows launcher) ==="
Write-Host "Repo: $repoRoot"

# 1. Node.js required
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js 22.5+ is required but was not found on PATH."
}

# 2. Install dependencies when missing
if (-not (Test-Path (Join-Path $repoRoot "node_modules"))) {
  Write-Host "Installing dependencies (npm install)..."
  Push-Location $repoRoot
  try {
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

# 3. Resolve the Codex app path
if (-not $CodexAppPath -and $env:CODEX_TASKBOARD_CODEX_APP_PATH) {
  $CodexAppPath = $env:CODEX_TASKBOARD_CODEX_APP_PATH
}
if (-not $CodexAppPath) {
  $winApps = Join-Path $env:ProgramFiles "WindowsApps"
  if (Test-Path $winApps) {
    $candidate = Get-ChildItem $winApps -Directory -Filter "OpenAI.Codex*" -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName "app\ChatGPT.exe" } |
      Where-Object { Test-Path $_ } |
      Select-Object -First 1
    if ($candidate) { $CodexAppPath = $candidate }
  }
}

# 4. Launch Codex with CDP when it is not already reachable, or when the
#    existing instance is orphaned (the window was closed but the process
#    lingers and still owns the port) or a restart was requested with -Force.
$cdpUrl = "http://127.0.0.1:$Port/json/version"
$cdpOk = Test-HttpOk $cdpUrl
$managedMain = Get-ManagedCodexMainProcess | Select-Object -First 1

if ($Force) {
  Write-Host "Force restart requested: stopping existing managed components first ..."
  Stop-TaskboardNodeProcesses
  Stop-ManagedCodex -cdpUrl $cdpUrl
  $cdpOk = Test-HttpOk $cdpUrl
  if ($cdpOk) {
    Write-Warning "CDP port $Port is still reachable after stopping the managed Codex."
    Write-Warning "Another (non-managed) process may be holding it. Pick a different port (-Port)."
  }
} elseif ($cdpOk -and -not $managedMain) {
  # The port is reachable but no managed Codex main process owns it. If any
  # launcher-profile residue remains, clean it up and relaunch; otherwise the
  # port belongs to an unknown process and must not be touched.
  if (@(Get-ManagedCodexProcesses).Count -gt 0) {
    Write-Host "CDP port $Port is reachable but its managed Codex process is gone. Cleaning up the residue ..."
    Stop-ManagedCodex -cdpUrl $cdpUrl
    $cdpOk = Test-HttpOk $cdpUrl
  } else {
    Write-Warning "CDP port $Port is already in use by an unknown process (not a managed Codex)."
    Write-Warning "Pick a different port (-Port) or free port $Port before continuing."
  }
} elseif ($cdpOk -and -not (Test-CdpWindowOpen $Port)) {
  # The managed Codex main process is alive but exposes no window target: the
  # window was closed while the process lingered. Restart it so a new window
  # opens.
  Write-Host "Existing managed Codex on port $Port has no open window. Restarting it ..."
  Stop-ManagedCodex -cdpUrl $cdpUrl
  $cdpOk = Test-HttpOk $cdpUrl
}

if (-not $cdpOk) {
  if (-not $CodexAppPath) {
    Write-Warning "Codex (ChatGPT.exe) not found. Install the Codex app from the Microsoft Store,"
    Write-Warning "or pass -CodexAppPath to point at the app. Continuing without launching Codex."
  } else {
    Write-Host "Launching Codex app with CDP port $Port ..."
    Start-Process -FilePath $CodexAppPath -ArgumentList @(
      "--user-data-dir=$dataDir\codex-profile",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=$Port",
      "--new-window"
    )
    if (-not (Wait-HttpOk $cdpUrl 30)) {
      Write-Warning "Codex CDP did not become reachable on port $Port in 30s."
    }
  }
} else {
  Write-Host "Codex CDP already reachable on port $Port."
}

# 5. Run the injector (watch + open). Its supervisor starts the Taskboard
#    service and writes .data/launcher-runtime.json.
$otherInjectorPort = $null
$injectorProcesses = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" -ErrorAction SilentlyContinue
foreach ($injectorProcess in $injectorProcesses) {
  $injectorCommand = [string]$injectorProcess.CommandLine
  if (-not $injectorCommand.Contains("scripts\codex-injector.mjs")) { continue }
  if ($injectorCommand.Contains("--port $Port")) { continue }
  $otherInjectorPort = "unknown"
  if ($injectorCommand -match "--port (\d+)") { $otherInjectorPort = $Matches[1] }
  break
}
if ($otherInjectorPort) {
  Write-Warning "Another Taskboard injector is already running on CDP port $otherInjectorPort."
  Write-Warning "Run exactly ONE Taskboard: each port creates a separate Codex window, service,"
  Write-Warning "and SQLite database, splitting task history. Reuse the same port or close the other instance."
}
if (-not (Has-NodeProcess "scripts\codex-injector.mjs" $Port)) {
  Write-Host "Starting Taskboard injector on port $Port ..."
  $injectorOut = Join-Path $logDir "injector.log"
  Start-Process -FilePath $node.Source -ArgumentList @(
    "scripts\codex-injector.mjs",
    "--watch", "--open", "--port", "$Port"
  ) -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $injectorOut -RedirectStandardError (Join-Path $logDir "injector.err.log")
} else {
  Write-Host "Taskboard injector already running."
}

# 6. Wait for the runtime file (the service URL) so the agent runner can attach.
$runtimeReady = $false
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  if (Test-Path $runtimeFile) { $runtimeReady = $true; break }
  Start-Sleep -Milliseconds 500
}

# 7. Run the agent runner (agents claiming & executing tasks) when not running.
if (-not (Has-NodeProcess "scripts\taskboard-agent-runner.mjs")) {
  Write-Host "Starting Taskboard agent runner ..."
  $runnerOut = Join-Path $logDir "agent-runner.log"
  Start-Process -FilePath $node.Source -ArgumentList @(
    "scripts\taskboard-agent-runner.mjs",
    "--watch"
  ) -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $runnerOut -RedirectStandardError (Join-Path $logDir "agent-runner.err.log")
} else {
  Write-Host "Taskboard agent runner already running."
}

# 8. Report
$serviceUrl = "http://127.0.0.1:47823"
Write-Host ""
Write-Host "Taskboard service: $serviceUrl  (data: $dataDir\taskboard.sqlite)"
Write-Host "Codex CDP:         $cdpUrl"
if ($runtimeReady) {
  Write-Host "Runtime file:     $runtimeFile"
} else {
  Write-Host "Runtime file:     not ready yet - check $logDir\injector.log"
}
Write-Host ""
Write-Host "Logs: $logDir"
Write-Host "Done. The Taskboard panel should appear in the Codex sidebar."
