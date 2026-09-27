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
pnpm exec tauri build --bundles nsis msi
if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }

$TargetRelease = Join-Path $RootDir "src-tauri\target\release"
$DistWin = Join-Path $RootDir "dist-win"

if (-not (Test-Path $DistWin)) {
    New-Item -ItemType Directory -Path $DistWin -Force | Out-Null
}

# Clear the previous run's artifacts first.
#
# Without this, dist-win only ever grows: every version leaves its installers
# behind next to the new ones, so the folder ends up holding several releases at
# once. It did - a 0.1.0 NSIS and MSI sat beside the 0.9.20 pair for days, and
# the newest build was not obvious without reading timestamps. Only the files
# this script itself produces are removed, so anything the operator put there by
# hand survives.
#
# Deliberately placed after the build rather than before it: a build that fails
# must not take the last known-good installers with it. The cost is that a
# failed build leaves stale artifacts in place, which is the recoverable half of
# the trade.
Write-Host "==> Clearing previous artifacts from dist-win/..." -ForegroundColor Cyan
$stale = @(
    (Join-Path $DistWin "termigo.exe"),
    (Join-Path $DistWin "termigo-cli.exe"),
    (Join-Path $DistWin "Termigo_*.exe"),
    (Join-Path $DistWin "Termigo_*.msi")
)
foreach ($pattern in $stale) {
    Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "    removed $($_.Name)"
        Remove-Item -Path $_.FullName -Force
    }
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

# The CLI sidecar comes from `src-tauri/binaries/`, NOT from `target/release/`.
#
# `build-cli.mjs` builds with an explicit `--target <host triple>` (it needs the
# triple to name the Go companion), so cargo writes the binary to
# `target/<triple>/release/termigo-cli.exe`. `target/release/termigo-cli.exe` is
# only produced by a build WITHOUT `--target`, which nothing here does - so
# copying from there ships whatever an older build left behind. It did: dist-win
# held a 408,576 byte CLI while the installer bundled a 390,144 byte one, and a
# person testing the loose exe was testing something the release does not
# contain. `binaries/termigo-cli-<triple>.exe` IS the file `bundle.externalBin`
# packs, so copying that makes dist-win and the installer the same artifact by
# construction.
$CliSidecar = Get-ChildItem -Path (Join-Path $RootDir "src-tauri\binaries") `
    -Filter "termigo-cli-*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if ($CliSidecar) {
    Safe-CopyFile -Path $CliSidecar.FullName -Destination (Join-Path $DistWin "termigo-cli.exe")
    Write-Host "==> Copied $($CliSidecar.Name) to dist-win/termigo-cli.exe" -ForegroundColor Green
} elseif (Test-Path (Join-Path $TargetRelease "termigo-cli.exe")) {
    # Keep a host build that skipped the sidecar step working rather than
    # silently producing no CLI at all.
    Safe-CopyFile -Path (Join-Path $TargetRelease "termigo-cli.exe") -Destination $DistWin
    Write-Host "==> Copied termigo-cli.exe from target/release (no sidecar found)" -ForegroundColor Yellow
} else {
    Write-Warning "No termigo-cli binary found in src-tauri/binaries or target/release"
}

$BundleNsis = Join-Path $TargetRelease "bundle\nsis"
$BundleMsi = Join-Path $TargetRelease "bundle\msi"

# Copy only THIS version's installers.
#
# Tauri does not clean its own bundle output: `target/release/bundle/nsis/`
# keeps every installer it has ever produced, and the same for `msi/`. A `*.exe`
# copy therefore shipped whatever was lying there - a 0.1.0 NSIS and MSI from a
# build weeks earlier reappeared in dist-win right after the cleanup above had
# removed them, carrying their original timestamps because Copy-Item preserves
# LastWriteTime. The cleanup looked broken when the copies had simply put them
# back. Scoping the match to the version in tauri.conf.json makes a stale
# installer unreachable no matter what the bundle folder accumulates.
$TauriConfPath = Join-Path $RootDir "src-tauri\tauri.conf.json"
$AppVersion = (Get-Content $TauriConfPath -Raw | ConvertFrom-Json).version
if (-not $AppVersion) {
    throw "could not read the app version from $TauriConfPath"
}
Write-Host "==> Bundling version $AppVersion" -ForegroundColor Cyan

$nsisInstallers = @(Get-ChildItem -Path "$BundleNsis\Termigo_${AppVersion}_*" -File -ErrorAction SilentlyContinue)
if ($nsisInstallers.Count -gt 0) {
    foreach ($installer in $nsisInstallers) {
        Safe-CopyFile -Path $installer.FullName -Destination $DistWin
        Write-Host "==> Copied $($installer.Name) to dist-win/" -ForegroundColor Green
    }
} else {
    Write-Warning "No NSIS installer for $AppVersion in $BundleNsis"
}

$msiInstallers = @(Get-ChildItem -Path "$BundleMsi\Termigo_${AppVersion}_*" -File -ErrorAction SilentlyContinue)
if ($msiInstallers.Count -gt 0) {
    foreach ($installer in $msiInstallers) {
        Safe-CopyFile -Path $installer.FullName -Destination $DistWin
        Write-Host "==> Copied $($installer.Name) to dist-win/" -ForegroundColor Green
    }
} else {
    Write-Warning "No MSI installer for $AppVersion in $BundleMsi"
}

Write-Host "==> Windows build complete! Artifacts located in $DistWin" -ForegroundColor Green
