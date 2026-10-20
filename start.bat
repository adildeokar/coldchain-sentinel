@echo off
rem Double-click to start ColdChain Sentinel (needs Node.js 18+). The browser opens automatically.
cd /d "%~dp0"
title ColdChain Sentinel server
node server\index.js %*
pause
