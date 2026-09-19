@echo off
setlocal
set "TOKEN=%GITHUB_TOKEN%"
if "%TOKEN%"=="" (
  echo GITHUB_TOKEN missing
  exit /b 1
)
curl.exe -s -H "Authorization: Bearer %TOKEN%" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" -d "{\"tag_name\":\"v0.9.18\",\"name\":\"Termigo v0.9.18\",\"body\":\"Windows installer release for Termigo v0.9.18. Includes NSIS setup, MSI installer, and portable binaries.\"}" https://api.github.com/repos/99apps-id/termigo/releases
endlocal
