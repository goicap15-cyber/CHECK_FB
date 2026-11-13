@echo off
chcp 65001 >nul
cd /d "%~dp0build\FB-Cookie-Checker-win32-x64"
start "" "FB-Cookie-Checker.exe"
