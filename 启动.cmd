@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if errorlevel 1 goto failed

where node.exe >nul 2>&1
if errorlevel 1 (
  echo 未找到 Node.js，请安装 Node.js 24 或更新版本后重新打开。
  goto failed
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo 未找到 npm.cmd，请检查 Node.js 安装和 PATH 配置。
  goto failed
)

set "DOUBAO_INSTALL_REQUIRED="
if not exist "node_modules\electron\dist\electron.exe" set "DOUBAO_INSTALL_REQUIRED=1"
if not exist "node_modules\sharp\package.json" set "DOUBAO_INSTALL_REQUIRED=1"
if defined DOUBAO_INSTALL_REQUIRED (
  echo 正在安装项目依赖，首次安装需要联网……
  call npm.cmd ci
  if errorlevel 1 goto failed
)

echo 正在构建 DouBaoVideo……
call npm.cmd run build
if errorlevel 1 goto failed

echo 正在打开桌面窗口……
call npm.cmd start
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo 启动未完成，请查看上方的错误信息。
pause
exit /b 1
