@echo off
title Chat On Steroids - Installer Olusturucu
echo ========================================================
echo   Chat On Steroids - Windows Installer Derleme
echo ========================================================
cd /d "%~dp0"

echo [1/3] Bagimliliklar ve varliklar hazirlaniyor...
call npm run icon
call npm run rg
call npm run tunnel
call npm run packaging:prepare

echo [2/3] Uygulama derleniyor...
call npm run build

echo [3/3] Windows x64 NSIS Installer paketleniyor...
call npx electron-builder --win --x64 --publish never

echo.
echo Islem tamamlandi! Kurulum dosyasi 'dist' klasorunde bulunabilir.
pause
