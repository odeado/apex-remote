@echo off
title ApexRemote - Agente Remoto
cls
echo ========================================================
echo   ⚡ ApexRemote - Agente del Equipo Remoto
echo ========================================================
echo.

if "%1"=="" (
    set /p SERVER_IP="Ingresa la IP del Servidor (o presiona Enter para localhost): "
) else (
    set SERVER_IP=%1
)

if "%SERVER_IP%"=="" set SERVER_IP=localhost

cd /d "%~dp0agent-node"
node agent.js %SERVER_IP%
pause
