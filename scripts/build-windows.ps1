# Termigo Windows Build Script
# Builds Termigo for Windows without bumping the version (maintains v0.9.8)

$ErrorActionPreference = "Stop"

Write-Host "==> Checking build prerequisites..." -ForegroundColor Cyan
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Error "pnpm is not found in PATH. Please install pnpm."
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Error "cargo / rust is not found in PATH. Please install Rust."
}

$RootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RootDir

Write-Host "==> Installing dependencies..." -ForegroundColor Cyan
pnpm install --frozen-lockfile

Write-Host "==> Building frontend and CLI..." -ForegroundColor Cyan
pnpm build:cli
pnpm build

Write-Host "==> Building Tauri Windows application..." -ForegroundColor Cyan
pnpm tauri build

$TargetRelease = Join-Path $RootDir "src-tauri\target\release"
$DistWin = Join-Path $RootDir "dist-win"

if (-not (Test-Path $DistWin)) {
    New-Item -ItemType Directory -Path $DistWin -Force | Out-Null
}

if (Test-Path (Join-Path $TargetRelease "termigo.exe")) {
    Copy-Item -Path (Join-Path $TargetRelease "termigo.exe") -Destination $DistWin -Force
    Write-Host "==> Copied termigo.exe to dist-win/" -ForegroundColor Green
}

if (Test-Path (Join-Path $TargetRelease "termigo-cli.exe")) {
    Copy-Item -Path (Join-Path $TargetRelease "termigo-cli.exe") -Destination $DistWin -Force
    Write-Host "==> Copied termigo-cli.exe to dist-win/" -ForegroundColor Green
}

$BundleNsis = Join-Path $TargetRelease "bundle\nsis"
if (Test-Path $BundleNsis) {
    Copy-Item -Path "$BundleNsis\*.exe" -Destination $DistWin -Force
    Write-Host "==> Copied installer to dist-win/" -ForegroundColor Green
}

Write-Host "==> Windows build complete! Artifacts located in $DistWin" -ForegroundColor Green
