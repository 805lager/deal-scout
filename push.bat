@echo off
cd /d "C:\Users\Shaun\Desktop\Personal_Shopping_Bot"

echo === Deal Scout Pre-push Syntax Check ===
echo.

python -m py_compile api\main.py
if %ERRORLEVEL% NEQ 0 ( echo SYNTAX ERROR in api\main.py & pause & exit /b 1 )

python -m py_compile scoring\gemini_pricer.py
if %ERRORLEVEL% NEQ 0 ( echo SYNTAX ERROR in scoring\gemini_pricer.py & pause & exit /b 1 )

python -m py_compile scoring\ebay_pricer.py
if %ERRORLEVEL% NEQ 0 ( echo SYNTAX ERROR in scoring\ebay_pricer.py & pause & exit /b 1 )

python -m py_compile scoring\product_evaluator.py
if %ERRORLEVEL% NEQ 0 ( echo SYNTAX ERROR in scoring\product_evaluator.py & pause & exit /b 1 )

echo All syntax checks passed.
echo.

echo === Syncing backend version ===
python sync_version.py
if %ERRORLEVEL% NEQ 0 ( echo Version sync failed & pause & exit /b 1 )
echo.

echo === Git Push ===
git add .
git status
echo.

set /p MSG="Commit message (or press Enter for default): "
if "%MSG%"=="" set MSG=chore: update project files

git commit -m "%MSG%"
git push origin main

echo.
echo Done! https://github.com/805lager/deal-scout
pause
