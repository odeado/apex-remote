@echo off
title ApexRemote - Servidor Relay
cls
echo ========================================================
echo   ⚡ ApexRemote - Servidor Central Relay
echo ========================================================
echo.
cd /d "%~dp0relay"
node server.js
pause
