# Termigo Windows Build Script
# Builds Termigo for Windows without bumping the version (maintains current version)

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

Write-Host "==> Ensuring dependencies..." -ForegroundColor Cyan
if (-not (Test-Path "node_modules/.bin/tsc")) {
    $env:CI = "true"
    pnpm dlx pnpm@11.9.0 install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
}

Write-Host "==> Building frontend and CLI..." -ForegroundColor Cyan
pnpm build:cli
if ($LASTEXITCODE -ne 0) { throw "build:cli failed" }
pnpm build
if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }

Write-Host "==> Building Tauri Windows application..." -ForegroundColor Cyan
pnpm tauri build --bundles nsis msi
if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }

$TargetRelease = Join-Path $RootDir "src-tauri\target\release"
$DistWin = Join-Path $RootDir "dist-win"

if (-not (Test-Path $DistWin)) {
    New-Item -ItemType Directory -Path $DistWin -Force | Out-Null
}

function Safe-CopyFile {
    param([string]$Path, [string]$Destination)
    $retries = 5
    while ($retries -gt 0) {
        try {
            Copy-Item -Path $Path -Destination $Destination -Force -ErrorAction Stop
            return
        } catch {
            $retries--
            if ($retries -le 0) { throw $_ }
            Start-Sleep -Milliseconds 800
        }
    }
}

if (Test-Path (Join-Path $TargetRelease "termigo.exe")) {
    Safe-CopyFile -Path (Join-Path $TargetRelease "termigo.exe") -Destination $DistWin
    Write-Host "==> Copied termigo.exe to dist-win/" -ForegroundColor Green
}

if (Test-Path (Join-Path $TargetRelease "termigo-cli.exe")) {
    Safe-CopyFile -Path (Join-Path $TargetRelease "termigo-cli.exe") -Destination $DistWin
    Write-Host "==> Copied termigo-cli.exe to dist-win/" -ForegroundColor Green
}

$BundleNsis = Join-Path $TargetRelease "bundle\nsis"
if (Test-Path $BundleNsis) {
    Safe-CopyFile -Path "$BundleNsis\*.exe" -Destination $DistWin
    Write-Host "==> Copied NSIS installer to dist-win/" -ForegroundColor Green
}

$BundleMsi = Join-Path $TargetRelease "bundle\msi"
if (Test-Path $BundleMsi) {
    Safe-CopyFile -Path "$BundleMsi\*.msi" -Destination $DistWin
    Write-Host "==> Copied MSI installer to dist-win/" -ForegroundColor Green
}

Write-Host "==> Windows build complete! Artifacts located in $DistWin" -ForegroundColor Green
