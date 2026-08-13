# Capture a PNG of a window by process name, for the README screenshots.
#
# Usage: powershell -File scripts/capture-screenshot.ps1 -Process termigo -Out docs/terminal.png
#
# Uses PrintWindow with PW_RENDERFULLCONTENT so the window renders its own
# contents into an off-screen bitmap. Screen-scraping (CopyFromScreen) captures
# whatever pixels sit at those coordinates instead, which silently grabs
# whatever window happens to be on top.
param(
  [string]$Process = "termigo",
  [string]$Out = "docs/shot.png",
  [int]$Width = 0,
  [int]$Height = 0,
  [int]$SettleSeconds = 3
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Cap {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int t,bool repaint);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$proc = Get-Process -Name $Process -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { throw "no visible window for process '$Process'" }
$hwnd = $proc.MainWindowHandle

[void][Cap]::ShowWindow($hwnd, 9)
if ($Width -gt 0 -and $Height -gt 0) {
  [void][Cap]::MoveWindow($hwnd, 60, 60, $Width, $Height, $true)
}
[void][Cap]::SetForegroundWindow($hwnd)
Start-Sleep -Seconds $SettleSeconds

$r = New-Object Cap+RECT
if (-not [Cap]::GetWindowRect($hwnd, [ref]$r)) { throw "GetWindowRect failed" }
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { throw "window has no area" }

$bmp = New-Object System.Drawing.Bitmap $w, $h
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $gfx.GetHdc()
# 2 = PW_RENDERFULLCONTENT, required for DirectComposition surfaces (WebView2).
$ok = [Cap]::PrintWindow($hwnd, $hdc, 2)
$gfx.ReleaseHdc($hdc)
$gfx.Dispose()
if (-not $ok) { $bmp.Dispose(); throw "PrintWindow failed" }

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
$bmp.Save((Join-Path (Get-Location) $Out), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved $Out ($w x $h)"
