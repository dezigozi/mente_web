@echo off
chcp 65001 >nul
echo ===================================
echo  メンテ実績レポート データ更新
echo ===================================
echo.

set SRC=..\data\master_data.csv
set DST=public\data\master_data.csv

if not exist "public\data" (
  mkdir "public\data"
  echo public\data フォルダを作成しました
)

if not exist "%SRC%" (
  echo [エラー] %SRC% が見つかりません
  pause
  exit /b 1
)

copy /Y "%SRC%" "%DST%" >nul
if %errorlevel% equ 0 (
  echo [OK] master_data.csv を public\data\ にコピーしました
) else (
  echo [エラー] コピーに失敗しました
  pause
  exit /b 1
)

echo.
echo データ更新完了。ブラウザで「最新データに更新」ボタンを押してください。
echo.
pause
