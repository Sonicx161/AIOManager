Add-Type -AssemblyName System.Drawing

function Get-VibrantColor {
    param ($path)
    try {
        $bitmap = [System.Drawing.Bitmap]::FromFile($path)
        $maxSaturation = -1
        $bestColor = "#FFFFFF"
        
        # Sample pixels
        for ($x = 0; $x -lt $bitmap.Width; $x += 5) {
            for ($y = 0; $y -lt $bitmap.Height; $y += 5) {
                $pixel = $bitmap.GetPixel($x, $y)
                if ($pixel.A -lt 200) { continue } # Skip transparent
                
                # Get HSB/HSV Saturation
                $max = ($pixel.R, $pixel.G, $pixel.B | Measure-Object -Maximum).Maximum
                $min = ($pixel.R, $pixel.G, $pixel.B | Measure-Object -Minimum).Minimum
                $delta = $max - $min
                
                if ($max -eq 0) { $saturation = 0 } else { $saturation = $delta / $max }
                
                # We want high saturation but also reasonable brightness (not black)
                # And ignore pure grays
                if ($saturation -gt $maxSaturation -and $max -gt 50 -and $saturation -gt 0.2) {
                    $maxSaturation = $saturation
                    $bestColor = "#{0:X2}{1:X2}{2:X2}" -f $pixel.R, $pixel.G, $pixel.B
                }
            }
        }
        return $bestColor
    }
    catch {
        return "ERROR"
    }
}

Write-Output "ACCENT:$(Get-VibrantColor src\assets\themes\aiometadata.png)"
