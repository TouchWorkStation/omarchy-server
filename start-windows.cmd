@echo off
rem Double-click to build and run UmbrelOS Touch on Windows (needs Node.js 20+ from nodejs.org).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
if not exist node_modules call npm ci --no-audit --no-fund || (pause & exit /b 1)
if not exist dist call npm run build || (pause & exit /b 1)
node server\cli.mjs %*
pause
