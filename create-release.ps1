$ErrorActionPreference='Stop'
$token=[System.Environment]::GetEnvironmentVariable('GITHUB_TOKEN','Process')
if (-not $token) { Write-Error 'GITHUB_TOKEN missing'; exit 1 }
$version=(Get-Content (Join-Path $PSScriptRoot 'package.json') | ConvertFrom-Json).version
$tagName="v$version"
$headers=@{Authorization='Bearer '+$token; Accept='application/vnd.github+json'; 'X-GitHub-Api-Version'='2022-11-28'}
$body=@{tag_name=$tagName; name="Termigo $tagName"; body="Windows installer release for Termigo $tagName. Includes NSIS setup, MSI installer, and portable binaries."} | ConvertTo-Json
$r=Invoke-RestMethod -Uri 'https://api.github.com/repos/99apps-id/termigo/releases' -Method Post -Headers $headers -Body $body -ContentType 'application/json'
Write-Output ('release_url='+$r.url)
Write-Output ('upload_url='+$r.upload_url)
