@echo off
rem start-taskboard.bat - Windows one-click launcher for Codex Taskboard.
rem Reuses the same approach as the local D:\CodexTools\start-taskboard.bat:
rem it delegates everything to the PowerShell launcher.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-taskboard.ps1" %*
