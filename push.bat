@echo off
cd /d "C:\Users\Shaun\Desktop\Personal_Shopping_Bot"

echo === Deal Scout — Pre-push Syntax Check ===
echo.

REM WHY: f-string with bare } causes SyntaxError that only shows up at runtime.
REM Catching it here prevents a failed Railway healthcheck + wasted deploy minutes.
python -m py_compile api\main.py
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo *** SYNTAX ERROR in api\main.py — aborting push ***
    pause
    exit /b 1
)
python -m py_compile scoring\gemini_pricer.py
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo *** SYNTAX ERROR in scoring\gemini_pricer.py — aborting push ***
    pause
    exit /b 1
)
python -m py_compile scoring\ebay_pricer.py
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo *** SYNTAX ERROR in scoring\ebay_pricer.py — aborting push ***
    pause
    exit /b 1
)
python -m py_compile scoring\product_evaluator.py
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo *** SYNTAX ERROR in scoring\product_evaluator.py — aborting push ***
    pause
    exit /b 1
)
echo All syntax checks passed.
echo.

echo === Deal Scout — Git Push ===
echo.

git status
echo.

REM Stage EVERYTHING — new files, modified files, deleted files.
git add .

echo === Files staged ===
git status
echo.

set /p MSG="Commit message (or press Enter for default): "
if "%MSG%"=="" set MSG=chore: update project files

git commit -m "%MSG%"

echo.
echo === Pushing to GitHub ===
git push origin main

echo.
echo === Done! Check https://github.com/805lager/deal-scout ===
pause
