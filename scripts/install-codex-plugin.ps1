# install-codex-plugin.ps1 - Register codex-taskboard as a native Codex plugin
#
# Goal: after running this, the Codex app shows "Codex Taskboard" under
# Plugins > Local Plugins (or a named marketplace), installable with one click,
# and its manage-taskboard skill becomes available to Codex agents.
#
# Two strategies:
#   A. If the `codex` CLI is available, use `codex plugin marketplace add
#      zs-13/codex-taskboard` (the official GitHub marketplace flow).
#   B. Otherwise register a personal marketplace at ~/.agents/plugins/marketplace.json
#      pointing at a local clone in ~/.codex/plugins/codex-taskboard, and tell the
#      user to restart Codex and install from Plugins > Local Plugins.

param(
  [switch]$SkipClone,
  [string]$RepoUrl = "https://github.com/zs-13/codex-taskboard.git"
)

$ErrorActionPreference = "Stop"

# Force UTF-8 on the console and in pipes to native commands so non-ASCII text
# (Chinese titles, paths, logs) is never re-encoded through the ANSI code page
# (GBK on zh-CN Windows) and turned into mojibake.
chcp 65001 > $null
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8

$homeDir = $HOME
$codexHome = Join-Path $homeDir ".codex"
$pluginsDir = Join-Path $codexHome "plugins"
# When this is a checked-out repo (CODEX_PLUGIN_LOCAL_PATH set, or -SkipClone
# from the Codex action), point the marketplace entry at the current directory
# instead of a fresh clone under ~/.codex/plugins.
# $PSScriptRoot is the scripts/ dir; the repo root is its parent.
$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginDir = if ($env:CODEX_PLUGIN_LOCAL_PATH) {
  $env:CODEX_PLUGIN_LOCAL_PATH
} elseif ($SkipClone) {
  # -SkipClone means the caller already has a checkout; use this repo.
  $repoRoot
} else {
  Join-Path $pluginsDir "codex-taskboard"
}
$agentsPluginsDir = Join-Path $homeDir ".agents\plugins"
$marketplaceFile = Join-Path $agentsPluginsDir "marketplace.json"

Write-Host "=== Install codex-taskboard as a native Codex plugin ==="
Write-Host "Codex home: $codexHome"

# 1. Prefer the official CLI flow
$codexCli = Get-Command codex -ErrorAction SilentlyContinue
if ($codexCli) {
  Write-Host "codex CLI found - using official marketplace flow."
  & codex plugin marketplace add "zs-13/codex-taskboard"
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Marketplace registered. Now install the plugin in the Codex app:"
    Write-Host "  Plugins > codex-taskboard marketplace > install 'Codex Taskboard'"
    Write-Host "or run:  codex plugin install codex-taskboard@codex-taskboard"
    exit 0
  }
  Write-Host "codex plugin marketplace add did not succeed; falling back to local registration."
}

# 2. Fallback: local personal marketplace
if (-not $SkipClone -and -not (Test-Path (Join-Path $pluginDir ".codex-plugin"))) {
  Write-Host "Cloning $RepoUrl into $pluginDir ..."
  New-Item -ItemType Directory -Force $pluginsDir | Out-Null
  git clone --depth 1 $RepoUrl $pluginDir
  if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
} elseif (Test-Path (Join-Path $pluginDir ".codex-plugin")) {
  Write-Host "Plugin already present at $pluginDir"
} else {
  Write-Host "Skipping clone (repo path already managed)."
}

# 3. Add/update the personal marketplace entry
New-Item -ItemType Directory -Force $agentsPluginsDir | Out-Null

$existing = @()
if (Test-Path $marketplaceFile) {
  try {
    $existing = (Get-Content -Raw $marketplaceFile | ConvertFrom-Json).plugins
  } catch {
    Write-Warning "Could not parse existing $marketplaceFile; will rewrite."
    $existing = @()
  }
}

# Marketplace source.path for a personal marketplace is home-relative (the
# bundled plugins use "./plugins/<name>", and the app resolves against $HOME).
# For a clone under ~/.codex/plugins we emit "./.codex/plugins/codex-taskboard";
# for a checked-out repo outside $HOME we fall back to its absolute path.
$pluginSourcePath = if ($pluginDir.StartsWith($homeDir)) {
  $rel = $pluginDir.Substring($homeDir.Length).TrimStart('\', '/')
  "./" + ($rel -replace '\\', '/')
} else {
  $pluginDir -replace '\\', '/'
}
$pluginEntry = @{
  name = "codex-taskboard"
  source = @{ source = "local"; path = $pluginSourcePath }
  policy = @{ installation = "AVAILABLE"; authentication = "ON_INSTALL" }
  category = "Productivity"
}

$plugins = @($existing | Where-Object { $_.name -ne "codex-taskboard" })
$plugins += $pluginEntry

$marketplace = @{
  name = "local-plugins"
  interface = @{ displayName = "Local Plugins" }
  plugins = @($plugins)
}

# Write UTF-8 without BOM so the Codex app parses it cleanly.
$json = $marketplace | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($marketplaceFile, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Personal marketplace updated: $marketplaceFile"

Write-Host ""
Write-Host "=== Next steps ==="
Write-Host "1. Fully quit and restart the Codex app."
Write-Host "2. Open Plugins (sidebar) > Local Plugins."
Write-Host "3. Install 'Codex Taskboard'."
Write-Host "4. The manage-taskboard skill is now available. Launch the panel with:"
Write-Host "     npm run codex        (or scripts\start-taskboard.bat on Windows)"
Write-Host ""
Write-Host "Done."
