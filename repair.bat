@echo off
setlocal
cd /d "%~dp0"

echo Восстановление Anime Audio Cleaner...
echo Это пересоздаст .venv и заново поставит зависимости.
echo.

if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" bootstrap.py --repair
    goto done
)

where py >nul 2>nul
if %errorlevel%==0 (
    py -3.12 bootstrap.py --repair
    goto done
)

python bootstrap.py --repair

:done
echo.
pause
