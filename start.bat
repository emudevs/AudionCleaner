@echo off
setlocal
cd /d "%~dp0"

echo ================================================================
echo Anime Audio Cleaner
echo ================================================================

if exist ".venv\Scripts\python.exe" goto bootstrap_existing

where py >nul 2>nul
if %errorlevel%==0 (
    py -3.12 -c "import sys; print(sys.version)" >nul 2>nul
    if %errorlevel%==0 (
        py -3.12 bootstrap.py
        if errorlevel 1 goto fail
        goto launch
    )
)

where python >nul 2>nul
if %errorlevel%==0 (
    python bootstrap.py
    if errorlevel 1 goto fail
    goto launch
)

echo Python не найден.
echo Установи Python 3.12 x64 и включи "Add Python to PATH".
pause
exit /b 1

:bootstrap_existing
".venv\Scripts\python.exe" bootstrap.py
if errorlevel 1 goto fail

:launch
".venv\Scripts\python.exe" app.py
exit /b 0

:fail
echo.
echo Установка завершилась с ошибкой.
pause
exit /b 1
