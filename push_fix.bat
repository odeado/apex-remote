@echo off
cd /d C:\Scripts\RustDesk
echo === Git status antes ===
git status
echo.
echo === Agregando archivos ===
git add client/app.js .gitignore
echo.
echo === Commit ===
git commit -m "fix: WebRTC ICE null guard + ocultar cursor overlay"
echo.
echo === Push a GitHub ===
git push
echo.
echo === LISTO. Render desplegara en ~2 min ===
echo Recarga el navegador con Ctrl+Shift+R despues de 2 minutos.
pause
