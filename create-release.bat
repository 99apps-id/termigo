@echo off
setlocal
set "TOKEN=%GITHUB_TOKEN%"
if "%TOKEN%"=="" (
  echo GITHUB_TOKEN missing
  exit /b 1
)
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set VERSION=%%v
set "TAG_NAME=v%VERSION%"
curl.exe --fail -s -H "Authorization: Bearer %TOKEN%" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" -d "{\"tag_name\":\"%TAG_NAME%\",\"name\":\"Termigo %TAG_NAME%\",\"body\":\"Windows installer release for Termigo %TAG_NAME%. Includes NSIS setup, MSI installer, and portable binaries.\"}" https://api.github.com/repos/99apps-id/termigo/releases
if %ERRORLEVEL% neq 0 (
  echo GitHub release creation failed with error %ERRORLEVEL%
  exit /b %ERRORLEVEL%
)
endlocal
