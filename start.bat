@echo off
chcp 65001 >nul
echo.
echo  =======================================
echo   Reminder Server - مدير التذكيرات
echo  =======================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  [خطأ] Node.js غير مثبّت.
    echo  حمّله من: https://nodejs.org
    echo.
    pause
    exit /b 1
)

if not exist node_modules (
    echo  تثبيت الحزم...
    call npm install
    echo.
)

echo  السيرفر يعمل على: http://localhost:3001
echo  اضغط Ctrl+C للإيقاف.
echo.
node server.js
pause
