@echo off
setlocal
cd /d "%~dp0"

rem 自动找 node：优先 PATH，其次豆包运行目录里的便携版
set "NODE_EXE="
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE (
  for /f "delims=" %%F in ('dir /b /s "%LOCALAPPDATA%\Doubao\User Data\sandbox_runtime\bases\node.exe" 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%F"
  )
)

if not defined NODE_EXE (
  echo [x] 没找到 Node.js。
  echo     安装一次即可：winget install --id OpenJS.NodeJS.LTS -e
  echo     装完关掉这个窗口，重新双击本文件。
  pause
  exit /b 1
)

echo 使用 Node: %NODE_EXE%
echo.
chcp 65001 >nul
"%NODE_EXE%" local-proxy.js
chcp 936 >nul
echo.
echo 代理已退出。如果上面有报错，把窗口内容发我。
pause