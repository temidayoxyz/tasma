# tools/screenshot.ps1
# Captures the running Tasma window to a PNG.
#
# A GUI project you cannot look at is a GUI project you are guessing about, so this is
# here to make "it renders" a checkable claim rather than a hopeful one.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools/screenshot.ps1
#   powershell -ExecutionPolicy Bypass -File tools/screenshot.ps1 -Output shot2.png -Delay 10

[CmdletBinding()]
param(
    [string]$Exe = '',
    [string]$Output = '',
    [int]$Delay = 8
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# $PSScriptRoot is not available while param defaults are bound in PowerShell 5.1,
# so the paths are resolved from the command itself once the body starts.
$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $toolsDir
if (-not $Exe) { $Exe = Join-Path $root 'src-tauri\target\debug\tasma.exe' }
if (-not $Output) { $Output = Join-Path $root 'screenshot.png' }

$signature = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class TasmaShot {
    public delegate bool EnumWindowsProc(IntPtr handle, IntPtr param);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr handle, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr handle, System.Text.StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr handle, System.Text.StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    /// Without this the calling process is DPI-virtualised and every rectangle comes
    /// back divided by the scale factor, so a screenshot captures only a corner of the
    /// window on a 125% or 150% display.
    public static void MakeDpiAware() {
        SetProcessDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2
    }

    public static string TitleOf(IntPtr handle) {
        var text = new System.Text.StringBuilder(512);
        GetWindowTextW(handle, text, 512);
        return text.ToString();
    }

    public static string ClassOf(IntPtr handle) {
        var text = new System.Text.StringBuilder(512);
        GetClassNameW(handle, text, 512);
        return text.ToString();
    }

    /// Every window owned by the process, with class, title and size - the quickest
    /// way to tell an app window from a debug console window.
    public static List<string> WindowsOf(uint target) {
        var list = new List<string>();
        EnumWindows((handle, param) => {
            uint pid;
            GetWindowThreadProcessId(handle, out pid);
            if (pid == target) {
                RECT rect;
                GetWindowRect(handle, out rect);
                list.Add(string.Format(
                    "{0} '{1}' visible={2} {3}x{4} at {5},{6}",
                    ClassOf(handle), TitleOf(handle), IsWindowVisible(handle),
                    rect.Right - rect.Left, rect.Bottom - rect.Top, rect.Left, rect.Top));
            }
            return true;
        }, IntPtr.Zero);
        return list;
    }

    /// The largest visible window belonging to the process, which is the app window
    /// rather than the debug console.
    public static IntPtr LargestWindow(uint target) {
        IntPtr best = IntPtr.Zero;
        long bestArea = 0;
        EnumWindows((handle, param) => {
            uint pid;
            GetWindowThreadProcessId(handle, out pid);
            if (pid == target && IsWindowVisible(handle)) {
                RECT rect;
                GetWindowRect(handle, out rect);
                long area = (long)(rect.Right - rect.Left) * (rect.Bottom - rect.Top);
                if (area > bestArea) { bestArea = area; best = handle; }
            }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    public static RECT RectOf(IntPtr handle) { RECT rect; GetWindowRect(handle, out rect); return rect; }
}
'@

Add-Type -TypeDefinition $signature -Language CSharp
[TasmaShot]::MakeDpiAware()

if (-not (Test-Path $Exe)) { throw "build the app first: $Exe not found" }

Write-Host "starting $Exe"
$process = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds $Delay

try {
    Write-Host "windows owned by the process:"
    foreach ($line in [TasmaShot]::WindowsOf([uint32]$process.Id)) { Write-Host "  $line" }

    $handle = [TasmaShot]::LargestWindow([uint32]$process.Id)
    if ($handle -eq [IntPtr]::Zero) { throw "no visible window found for pid $($process.Id)" }

    [TasmaShot]::SetForegroundWindow($handle) | Out-Null
    Start-Sleep -Milliseconds 700

    $rect = [TasmaShot]::RectOf($handle)
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    $dpi = [TasmaShot]::GetDpiForSystem()
    Write-Host "window ${width}x${height} at $($rect.Left),$($rect.Top); system dpi $dpi (scale $([Math]::Round($dpi / 96.0, 3))x)"
    Write-Host "title: $([TasmaShot]::TitleOf($handle))"

    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $dc = $graphics.GetHdc()
    # PW_RENDERFULLCONTENT: needed for composited (WebView2) windows.
    $ok = [TasmaShot]::PrintWindow($handle, $dc, 2)
    $graphics.ReleaseHdc($dc)
    $graphics.Dispose()

    $bitmap.Save($Output, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    Write-Host "PrintWindow returned $ok; wrote $Output"
}
finally {
    Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
}
