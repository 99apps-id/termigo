# Capture a PNG of a window by process name, for the README screenshots.
#
# Usage: powershell -File scripts/capture-screenshot.ps1 -Process termigo -Out docs/shot.png
#
# WebView2 renders through DirectComposition, and PrintWindow returns a black
# bitmap for those surfaces (intermittently - it can appear to work once). So
# the window is pinned topmost and the screen is read instead, which captures
# what is actually composited. Topmost is what makes that safe: without it the
# read silently picks up whatever window happens to be in front.
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
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int t, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static readonly IntPtr TOPMOST = new IntPtr(-1);
  public static readonly IntPtr NOTOPMOST = new IntPtr(-2);
}
"@

$proc = Get-Process -Name $Process -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { throw "no visible window for process '$Process'" }
$hwnd = $proc.MainWindowHandle

[void][Cap]::ShowWindow($hwnd, 9)   # SW_RESTORE

# Pin above everything, optionally resizing in the same call.
$SWP_NOSIZE = 0x0001; $SWP_NOMOVE = 0x0002; $SWP_SHOWWINDOW = 0x0040
if ($Width -gt 0 -and $Height -gt 0) {
  [void][Cap]::SetWindowPos($hwnd, [Cap]::TOPMOST, 60, 40, $Width, $Height, $SWP_SHOWWINDOW)
} else {
  [void][Cap]::SetWindowPos($hwnd, [Cap]::TOPMOST, 0, 0, 0, 0, $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_SHOWWINDOW)
}
[void][Cap]::SetForegroundWindow($hwnd)
Start-Sleep -Seconds $SettleSeconds   # let the webview repaint after the move

try {
  $r = New-Object Cap+RECT
  if (-not [Cap]::GetWindowRect($hwnd, [ref]$r)) { throw "GetWindowRect failed" }
  $w = $r.Right - $r.Left
  $h = $r.Bottom - $r.Top
  if ($w -le 0 -or $h -le 0) { throw "window has no area" }

  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $gfx.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $gfx.Dispose()

  $dir = Split-Path -Parent $Out
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  $bmp.Save((Join-Path (Get-Location) $Out), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "saved $Out ($w x $h)"
}
finally {
  # Always un-pin, or the window stays above everything after the capture.
  [void][Cap]::SetWindowPos($hwnd, [Cap]::NOTOPMOST, 0, 0, 0, 0, $SWP_NOSIZE -bor $SWP_NOMOVE)
}
