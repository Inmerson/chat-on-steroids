@echo off
title Chat On Steroids (Gelistirici Modu)
echo ========================================================
echo   Chat On Steroids - Gelistirici Modu Baslatiliyor...
echo ========================================================
cd /d "%~dp0"

echo [1/2] Bagimliliklar kontrol ediliyor...
if not exist "node_modules" (
    echo Paketler eksik, npm install calistiriliyor...
    call npm install
)

echo [2/2] Electron uygulamasi baslatiliyor...
call npm run dev
pause
