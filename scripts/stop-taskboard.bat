@echo off
rem stop-taskboard.bat - Windows one-click stop for Codex Taskboard.
rem Stops the managed Codex window (ChatGPT.exe) and the background node
rem processes (Taskboard service, CDP injector, agent runner) that
rem scripts\start-taskboard.bat started. Delegates to the PowerShell stop
rem script so the process-identification logic stays in one place.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-taskboard.ps1" %*
