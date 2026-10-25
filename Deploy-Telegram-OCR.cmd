@echo off
setlocal
"%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "%~dp0scripts\release-production-ocr.mjs" --deploy
if errorlevel 1 echo Deployment did not complete. Please send only the final status, never credentials.
pause
