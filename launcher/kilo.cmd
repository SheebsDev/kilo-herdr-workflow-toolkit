@ECHO off
SETLOCAL
REM Skip this prepended shim before delegating to the installed Windows command.
SET "PATH=%PATH:*;=%"
IF /I NOT "%~1"=="--workflow-prompt-file" GOTO delegate
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0kilo-with-prompt.ps1" "%~2"
EXIT /b %ERRORLEVEL%

:delegate
CALL kilo %*
EXIT /b %ERRORLEVEL%
