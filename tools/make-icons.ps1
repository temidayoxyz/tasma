# tools/make-icons.ps1
# Generates Tasma's application icons from code so the repo carries no binary blobs
# that nobody can regenerate. Produces a multi-resolution .ico (DIB entries for small
# sizes, PNG entries for large ones - the layout the Windows shell expects) plus the
# loose PNGs Tauri wants for bundling.
#
# Usage: powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1

[CmdletBinding()]
param(
    [int[]]$Sizes = @(16, 24, 32, 48, 64, 128, 256)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$OutDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri\icons'
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

# Tasma mark: rounded tile with three flowing waves (the Wisp-ish activity motif)
# painted with a green -> violet horizontal gradient.
function New-TasmaMark {
    param([int]$S)

    $bmp = New-Object System.Drawing.Bitmap -ArgumentList @([int]$S, [int]$S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    # NOTE: PowerShell 5.1 mis-parses inline `New-Object T($a, $x - 2 * $y)` argument
    # lists (it tries to multiply an Object[]), so constructors here get an explicit
    # -ArgumentList array instead.
    $pad = [double]$S * 0.015
    $side = [double]$S - (2.0 * $pad)
    $rect = New-Object System.Drawing.RectangleF -ArgumentList @([float]$pad, [float]$pad, [float]$side, [float]$side)
    $d = [double]$S * 0.235 * 2.0

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $c1 = [System.Drawing.Color]::FromArgb(255, 19, 21, 28)
    $c2 = [System.Drawing.Color]::FromArgb(255, 9, 10, 14)
    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 90.0)
    $g.FillPath($bg, $path)

    $edgeWidth = [float][Math]::Max(1.0, [double]$S * 0.018)
    $edge = New-Object System.Drawing.Pen -ArgumentList @([System.Drawing.Color]::FromArgb(46, 255, 255, 255), $edgeWidth)
    $g.DrawPath($edge, $path)

    $green = [System.Drawing.Color]::FromArgb(255, 61, 220, 161)
    $violet = [System.Drawing.Color]::FromArgb(255, 139, 92, 246)
    $wave = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $green, $violet, 0.0)
    $penWidth = [float][Math]::Max(1.3, [double]$S * 0.068)
    $pen = New-Object System.Drawing.Pen -ArgumentList @($wave, $penWidth)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    for ($i = 0; $i -lt 3; $i++) {
        $phase = $i * ([Math]::PI * 0.62)
        $amp = $S * (0.052 - $i * 0.009)
        $y0 = $S * (0.375 + $i * 0.125)
        $pts = [System.Drawing.PointF[]]::new(41)
        for ($k = 0; $k -le 40; $k++) {
            $t = [double]$k / 40.0
            $px = [double]$S * (0.175 + 0.65 * $t)
            $py = $y0 + [Math]::Sin($t * [Math]::PI * 2.0 + $phase) * $amp
            $pts[$k] = [System.Drawing.PointF]::new([float]$px, [float]$py)
        }
        $g.DrawLines($pen, $pts)
    }

    $pen.Dispose(); $wave.Dispose(); $edge.Dispose(); $bg.Dispose(); $path.Dispose(); $g.Dispose()
    return $bmp
}


function Get-PngBytes {
    param([System.Drawing.Bitmap]$Bmp)
    $ms = New-Object System.IO.MemoryStream
    $Bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    return $ms.ToArray()
}

# Classic 32bpp DIB icon entry: BITMAPINFOHEADER + bottom-up BGRA rows + 1bpp AND mask.
function Get-DibBytes {
    param([System.Drawing.Bitmap]$Bmp)
    $S = $Bmp.Width
    $rect = New-Object System.Drawing.Rectangle(0, 0, $S, $S)
    $data = $Bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $data.Stride
    $raw = [byte[]]::new($stride * $S)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length)
    $Bmp.UnlockBits($data)

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    $bw.Write([uint32]40)                       # biSize
    $bw.Write([int32]$S)                        # biWidth
    $bw.Write([int32]($S * 2))                  # biHeight (XOR + AND plane)
    $bw.Write([uint16]1)                        # biPlanes
    $bw.Write([uint16]32)                       # biBitCount
    $bw.Write([uint32]0)                        # biCompression = BI_RGB
    $bw.Write([uint32]0); $bw.Write([int32]0); $bw.Write([int32]0)
    $bw.Write([uint32]0); $bw.Write([uint32]0)
    for ($y = $S - 1; $y -ge 0; $y--) { $bw.Write($raw, $y * $stride, $S * 4) }
    $maskStride = [int]([Math]::Floor(($S + 31) / 32) * 4)
    $mask = [byte[]]::new($maskStride * $S)
    $bw.Write($mask, 0, $mask.Length)
    $bw.Flush()
    return $ms.ToArray()
}

$entries = @()
foreach ($s in $Sizes) {
    $bmp = New-TasmaMark -S $s
    $bytes = if ($s -le 64) { Get-DibBytes -Bmp $bmp } else { Get-PngBytes -Bmp $bmp }
    $entries += [pscustomobject]@{ Size = $s; Bytes = $bytes }
    if ($s -eq 32) { [System.IO.File]::WriteAllBytes((Join-Path $OutDir '32x32.png'), (Get-PngBytes -Bmp $bmp)) }
    if ($s -eq 128) { [System.IO.File]::WriteAllBytes((Join-Path $OutDir '128x128.png'), (Get-PngBytes -Bmp $bmp)) }
    if ($s -eq 256) { [System.IO.File]::WriteAllBytes((Join-Path $OutDir '128x128@2x.png'), (Get-PngBytes -Bmp $bmp)) }
    $bmp.Dispose()
}

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint16]0)                 # reserved
$bw.Write([uint16]1)                 # type = icon
$bw.Write([uint16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
    $dim = if ($e.Size -ge 256) { 0 } else { $e.Size }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$e.Bytes.Length); $bw.Write([uint32]$offset)
    $offset += $e.Bytes.Length
}
foreach ($e in $entries) { $bw.Write($e.Bytes, 0, $e.Bytes.Length) }
$bw.Flush()

$ico = Join-Path $OutDir 'icon.ico'
[System.IO.File]::WriteAllBytes($ico, $ms.ToArray())
Write-Host ("Tasma icons written to {0}" -f $OutDir)
Write-Host ("  icon.ico  {0} bytes, {1} sizes ({2})" -f (Get-Item $ico).Length, $entries.Count, ($Sizes -join ', '))
Get-ChildItem $OutDir -Filter *.png | ForEach-Object { Write-Host ("  {0,-16} {1} bytes" -f $_.Name, $_.Length) }
