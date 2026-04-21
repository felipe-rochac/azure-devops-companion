try {
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap(128, 128)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $rect = New-Object System.Drawing.Rectangle(0, 0, 128, 128)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = 24
    $path.AddArc(0, 0, $r, $r, 180, 90)
    $path.AddArc(128-$r, 0, $r, $r, 270, 90)
    $path.AddArc(128-$r, 128-$r, $r, $r, 0, 90)
    $path.AddArc(0, 128-$r, $r, $r, 90, 90)
    $path.CloseFigure()
    $darkAzure = [System.Drawing.Color]::FromArgb(255, 0, 120, 215)
    $brush = New-Object System.Drawing.SolidBrush($darkAzure)
    $g.FillPath($brush, $path)

    $whitePen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 6)
    $whiteBrush = [System.Drawing.Brushes]::White
    $g.DrawLine($whitePen, 30, 30, 30, 98)
    $g.DrawLine($whitePen, 30, 98, 70, 64)
    $g.FillEllipse($whiteBrush, 24, 24, 12, 12)
    $g.FillEllipse($whiteBrush, 24, 92, 12, 12)
    $g.FillEllipse($whiteBrush, 64, 58, 12, 12)

    $cyanBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Cyan)
    $g.FillEllipse($cyanBrush, 85, 75, 20, 20)
    $g.FillPie($cyanBrush, 75, 90, 40, 30, 180, 180)

    $checkPen = New-Object System.Drawing.Pen([System.Drawing.Color]::LimeGreen, 4)
    $g.DrawLine($checkPen, 105, 95, 112, 102)
    $g.DrawLine($checkPen, 112, 102, 122, 88)

    $bmp.Save('resources/icon.png', [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    Write-Host 'Success'
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
