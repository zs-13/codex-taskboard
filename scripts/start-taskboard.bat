@echo off
rem start-taskboard.bat - Windows one-click launcher for Codex Taskboard.
rem Delegates to the PowerShell launcher, which handles the whole lifecycle
rem (local service, CDP injector, agent runner) and stays idempotent across runs.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-taskboard.ps1" %*
