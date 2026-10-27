@echo off
REM Skill Vault setup. Options: -Desktop, -Uninstall, -NoLaunch, -WhatIf (see setup.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
exit /b %RC%
