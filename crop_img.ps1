param([string]$Src, [string]$Dst, [double]$FromRatio = 0.45, [double]$ToRatio = 1.0)
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($Src)
$h = $src.Height
$y0 = [int]($h * $FromRatio)
$y1 = [int]($h * $ToRatio)
$ch = $y1 - $y0
if ($ch -lt 10) { $ch = $h; $y0 = 0 }
$crop = New-Object System.Drawing.Bitmap($src.Width, $ch)
$g = [System.Drawing.Graphics]::FromImage($crop)
$g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $crop.Width, $crop.Height)), (New-Object System.Drawing.Rectangle(0, $y0, $crop.Width, $crop.Height)), [System.Drawing.GraphicsUnit]::Pixel)
$crop.Save($Dst, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $crop.Dispose(); $src.Dispose()
Write-Output "CROPPED $Dst"
