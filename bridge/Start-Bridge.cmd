@echo off
title Vid2Study bridge
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org then run this again. & pause & exit /b 1)
node setup.mjs %*
echo.
echo Press any key to close this window.
pause >nul
