# Generate round Omega (Ω) app icon for electron-builder (1024x1024 PNG).
$ErrorActionPreference = 'Stop'
$out = Join-Path $PSScriptRoot '..\apps\desktop\resources\icon.png'
$dir = Split-Path $out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

Add-Type -AssemblyName System.Drawing
$s = 1024
$bmp = New-Object System.Drawing.Bitmap $s, $s
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))

$rect = New-Object System.Drawing.Rectangle 0, 0, $s, $s
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  [System.Drawing.Color]::FromArgb(255, 99, 102, 241),
  [System.Drawing.Color]::FromArgb(255, 49, 46, 129),
  45
)
$g.FillEllipse($brush, 48, 48, $s - 96, $s - 96)

$omega = [char]937
$font = New-Object System.Drawing.Font(
  'Segoe UI',
  560,
  [System.Drawing.FontStyle]::Bold,
  [System.Drawing.GraphicsUnit]::Pixel
)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$textRect = New-Object System.Drawing.RectangleF 0, 40, $s, $s
$g.DrawString($omega, $font, [System.Drawing.Brushes]::White, $textRect, $sf)

$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)

$icoPath = Join-Path $dir 'icon.ico'
$iconSizes = @(16, 32, 48, 256)
$iconImages = New-Object System.Collections.Generic.List[System.Drawing.Bitmap]
foreach ($size in $iconSizes) {
  $iconImages.Add((New-Object System.Drawing.Bitmap $bmp, $size, $size))
}
$iconHandle = $iconImages[$iconImages.Count - 1].GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($iconHandle)
$icoStream = [System.IO.File]::Create($icoPath)
$icon.Save($icoStream)
$icoStream.Close()
$icon.Dispose()
foreach ($img in $iconImages) { $img.Dispose() }

$g.Dispose()
$bmp.Dispose()
$brush.Dispose()
$font.Dispose()

Write-Host "Wrote $out"
Write-Host "Wrote $icoPath"
