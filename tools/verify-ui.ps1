# tools/verify-ui.ps1 - drives the real window and captures a screenshot per step.
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
    public static void Click(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(120);
        mouse_event(0x0002u, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(60);
        mouse_event(0x0004u, 0, 0, 0, IntPtr.Zero);
    }
}
'@ -Language CSharp

$process = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds 9

try {
    $handle = [UiClick]::Largest([uint32]$process.Id)
    if ($handle -eq [IntPtr]::Zero) { throw 'no window' }
    [UiClick]::SetForegroundWindow($handle) | Out-Null
    Start-Sleep -Milliseconds 700
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

    # Steps are "x,y" measured from the window's top-left, separated by "|".
    $index = 0
    foreach ($step in ($Steps -split '\|')) {
        if (-not $step.Trim()) { continue }
        $xy = $step -split ','
        $x = $rect.Left + [int]$xy[0]
        $y = $rect.Top + [int]$xy[1]
        Write-Host "click $x,$y"
        [UiClick]::Click($x, $y)
        Start-Sleep -Milliseconds 900
        $index++
        Capture("step$index")
    }
}
finally {
    Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
}
