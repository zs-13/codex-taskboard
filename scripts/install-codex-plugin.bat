@echo off
rem install-codex-plugin.bat - Windows one-click native Codex plugin installer
rem Delegates to install-codex-plugin.ps1.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-codex-plugin.ps1" %*
