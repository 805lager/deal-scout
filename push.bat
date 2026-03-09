@echo off
cd /d "C:\Users\Shaun\Desktop\Personal_Shopping_Bot"

echo === Deal Scout — Git Push ===
echo.

git status
echo.

REM Stage EVERYTHING — new files, modified files, deleted files.
REM WHY: old push.bat used explicit paths and silently skipped new files
REM (railway.toml, main.py, Procfile, new scoring modules, etc.)
git add .

echo === Files staged ===
git status
echo.

REM Prompt for a commit message so every push is meaningful in the log
set /p MSG="Commit message (or press Enter for default): "
if "%MSG%"=="" set MSG=chore: update project files

git commit -m "%MSG%"

echo.
echo === Pushing to GitHub ===
git push origin main

echo.
echo === Done! Check https://github.com/805lager/deal-scout ===
pause
