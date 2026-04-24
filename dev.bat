@echo off
REM Windows: PowerShell の ExecutionPolicy で npm.ps1 が弾かれる場合の回避。
REM この bat は npm.cmd 経由で同じ Vite を起動する（WEB フォルダでダブルクリック可）
cd /d "%~dp0"
echo Starting Vite via npm.cmd ...
npm.cmd run dev
