@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Setup-ACL.ps1" -BuildInstaller
if errorlevel 1 pause
