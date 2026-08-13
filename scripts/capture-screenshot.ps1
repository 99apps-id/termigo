# Capture a PNG of a window by process name, for the README screenshots.
#
# Usage: powershell -File scripts/capture-screenshot.ps1 -Process termigo -Out docs/terminal.png
#
# Captures the window's client area via BitBlt rather than the whole screen, so
# the shot has no desktop background or other windows in it.
param(
  [string]$Process = "termigo",
  [string]$Out = "docs/shot.png",
  [int]$SettleSeconds = 2
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$proc = Get-Process -Name $Process -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1
if (-not $proc) { throw "no visible window for process '$Process'" }

$hwnd = $proc.MainWindowHandle
[void][Win]::ShowWindow($hwnd, 9)   # SW_RESTORE
[void][Win]::SetForegroundWindow($hwnd)
Start-Sleep -Seconds $SettleSeconds  # let the webview paint

$rect = New-Object Win+RECT
if (-not [Win]::GetWindowRect($hwnd, [ref]$rect)) { throw "GetWindowRect failed" }
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) { throw "window has no area ($width x $height)" }

$bmp = New-Object System.Drawing.Bitmap $width, $height
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
$gfx.Dispose()

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
$full = Join-Path (Get-Location) $Out
$bmp.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Output "saved $Out ($width x $height)"
