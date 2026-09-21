@echo off
title Aaryan Aqua Needs - MacBook (macOS) App Distribution
color 0b
echo ========================================================
echo   Aaryan Aqua Needs - MacBook (macOS) App
echo ========================================================
echo.

if exist "Ready_To_Share_Apps\*.dmg" (
    echo [FOUND] Production macOS DMG package is ready in Ready_To_Share_Apps!
    echo.
    dir /b Ready_To_Share_Apps\*.dmg
    dir /b Ready_To_Share_Apps\*.zip
    echo.
    echo ========================================================
    echo   Opening Ready_To_Share_Apps folder for customer sharing...
    echo ========================================================
    explorer Ready_To_Share_Apps
    goto end
)

echo [1/2] Packaging macOS application (.zip / .dmg)...
call npm run build:mac

if %ERRORLEVEL% equ 0 (
    echo.
    echo ========================================================
    echo   [SUCCESS] MacBook (macOS) App built successfully!
    echo   Check the 'dist' folder for your macOS packages.
    echo ========================================================
    echo.
    explorer dist
) else (
    echo.
    echo [NOTE] macOS DMG creation requires macOS host tools.
    echo The GitHub Actions cloud pipeline (build-desktop-apps.yml)
    echo automatically compiles 100%% native Universal DMGs on Apple runners.
    echo.
    if exist "Ready_To_Share_Apps" explorer Ready_To_Share_Apps
)

:end
pause
