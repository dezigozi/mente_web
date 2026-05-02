@echo off
cd /d "%~dp0"
echo =========================================
echo  Mente Jisseki - Master Data Push
echo =========================================
echo.
git diff --quiet -- public/data/master_data.csv
if %errorlevel% == 0 (
    echo [NO CHANGES] master_data.csv has not been modified.
    echo Press any key to exit...
    pause > nul
    exit /b 1
)
echo [1/4] Checking changed files...
git status public/data/master_data.csv
echo.
powershell -NoProfile -Command "Get-Date -Format 'yyyy/MM/dd' | Out-File '%~dp0_date_tmp.txt' -Encoding ASCII -NoNewline"
set /p TODAY=<"%~dp0_date_tmp.txt"
del "%~dp0_date_tmp.txt" > nul 2>&1
echo [2/4] Committing...
git add public/data/master_data.csv
git^ commit -m "data: master_data.csv updated %TODAY%"
if %errorlevel% neq 0 (
    echo [ERROR] Commit failed.
    pause > nul
    exit /b 1
)
echo [3/4] Pulling latest from GitHub (before push)...
git pull --rebase origin master
if %errorlevel% neq 0 (
    echo [ERROR] Pull failed. Try: git stash -u
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
echo Done.
pause > nul