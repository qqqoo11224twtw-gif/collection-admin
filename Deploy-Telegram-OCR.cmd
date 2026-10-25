@echo off
chcp 65001 >nul
setlocal
"%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "%~dp0scripts\launch-production-ocr.mjs"
echo.
echo Release process finished. Window will remain open.
cmd /k
