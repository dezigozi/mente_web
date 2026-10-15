@echo off
rem Drop the tab price xlsx onto this bat: xlsx -> public/data/tab_data.csv -> commit -> push
cd /d "%~dp0.."
echo =========================================
echo  Mente Jisseki - Tab Excel Update
echo =========================================
echo.
if "%~1"=="" (
    echo [ERROR] Drag and drop the xlsx file onto this bat.
    pause > nul
    exit /b 1
)
echo [1/4] Converting xlsx to tab_data.csv...
node scripts\tab-xlsx-to-csv.mjs "%~1"
if %errorlevel% neq 0 (
    echo [ERROR] Convert failed.
    pause > nul
    exit /b 1
)
git diff --quiet -- public/data/tab_data.csv
if %errorlevel% == 0 (
    echo [NO CHANGES] tab_data.csv is the same as before.
    pause > nul
    exit /b 0
)
git diff --stat -- public/data/tab_data.csv
echo.
powershell -NoProfile -Command "Get-Date -Format 'yyyy/MM/dd' | Out-File '%TEMP%\_tab_date_tmp.txt' -Encoding ASCII -NoNewline"
set /p TODAY=<"%TEMP%\_tab_date_tmp.txt"
del "%TEMP%\_tab_date_tmp.txt" > nul 2>&1
echo [2/4] Committing...
git add public/data/tab_data.csv
git commit -m "data: tab_data.csv updated %TODAY%"
if %errorlevel% neq 0 (
    echo [ERROR] Commit failed.
    pause > nul
    exit /b 1
)
echo [3/4] Pulling latest from GitHub...
git pull --rebase --autostash origin master
if %errorlevel% neq 0 (
    echo [ERROR] Pull failed.
    pause > nul
    exit /b 1
)
echo [4/4] Pushing to GitHub...
git push origin master
if %errorlevel% neq 0 (
    echo [ERROR] Push failed.
    pause > nul
    exit /b 1
)
echo.
echo Done.
pause > nul
