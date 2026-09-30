# tools/verify-ui.ps1  (TEMP - coordinates are measured from a screenshot, then deleted)
[CmdletBinding()]
param(
    [string]$Exe = 'D:\Codebase\tasma\src-tauri\target\debug\tasma.exe',
    [string]$Steps = '',
    [string]$Prefix = 'D:\Codebase\tasma\ui'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class UiClick {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
    public static void DpiAware() { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
    // Pins the window to the top-left of the work area without resizing it, so a
    // coordinate measured off a screenshot lands on the same pixel every run.
    public static void Pin(IntPtr h) { SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0004); }
    public static IntPtr Largest(uint target) {
        IntPtr best = IntPtr.Zero; long area = 0;
        EnumWindows((h, p) => {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid == target && IsWindowVisible(h)) {
                RECT r; GetWindowRect(h, out r);
                long a = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
                if (a > area) { area = a; best = h; }
            }
            return true;
        }, IntPtr.Zero);
        return best;
    }
    public static RECT Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return r; }
    public static void Click(int x, int y, bool right) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(120);
        mouse_event(right ? 0x0008u : 0x0002u, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(60);
        mouse_event(right ? 0x0010u : 0x0004u, 0, 0, 0, IntPtr.Zero);
    }
}
'@ -Language CSharp

[UiClick]::DpiAware()
$process = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds 9

try {
    $handle = [UiClick]::Largest([uint32]$process.Id)
    if ($handle -eq [IntPtr]::Zero) { throw "no window" }
    [UiClick]::SetForegroundWindow($handle) | Out-Null
    [UiClick]::Pin($handle)
    Start-Sleep -Milliseconds 900

    # The first click after a window is raised only activates it, so a warm-up click on
    # the (empty) title bar stops the first real step from being swallowed.
    $warm = [UiClick]::Rect($handle)
    [UiClick]::Click($warm.Left + [int](($warm.Right - $warm.Left) / 2), $warm.Top + 10, $false)
    Start-Sleep -Milliseconds 500
    $rect = [UiClick]::Rect($handle)
    Write-Host "window $($rect.Right - $rect.Left)x$($rect.Bottom - $rect.Top) at $($rect.Left),$($rect.Top)"

    function Capture([string]$name) {
        $r = [UiClick]::Rect($handle)
        $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $dc = $g.GetHdc()
        [UiClick]::PrintWindow($handle, $dc, 2) | Out-Null
        $g.ReleaseHdc($dc); $g.Dispose()
        $path = "$Prefix-$name.png"
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        Write-Host "wrote $path"
    }

    $index = 0
    foreach ($step in ($Steps -split '\|')) {
        if (-not $step.Trim()) { continue }
        $xy = $step -split ','
        $right = $false
        if ($xy.Count -gt 2 -and $xy[2] -eq 'r') { $right = $true }
        # Re-read the rect every step: compact mode resizes the window, so coordinates
        # captured before the first click would land on the wrong pixels.
        $rect = [UiClick]::Rect($handle)
        $x = $rect.Left + [int]$xy[0]
        $y = $rect.Top + [int]$xy[1]
        Write-Host "click $x,$y right=$right (window $($rect.Right - $rect.Left)x$($rect.Bottom - $rect.Top))"
        [UiClick]::Click($x, $y, $right)
        Start-Sleep -Milliseconds 900
        $index++
        Capture("step$index")
    }
}
finally {
    Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
}
