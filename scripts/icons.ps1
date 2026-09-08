# Icons aus den beiden Quellzeichnungen erzeugen.
#
#   pwsh scripts/icons.ps1
#
# Quellen liegen in src-tauri/icons/source/ – je Zustand eine Datei:
#   icon.svg          ruhend  (Flaeche salbeigruen, Bogen offen)
#   icon-running.svg  laeuft  (Flaeche terrakotta, Ring geschlossen)
#
# Dieselbe Zeichnung fuer jede Groesse und auch fuer das Logo in der App
# (static/logo.svg, static/logo-running.svg sind Kopien davon).
#
# Was dieses Skript beitraegt, ist nicht die Zeichnung, sondern die Groessen:
# Windows fragt Icons in 16, 20, 24, 32, 40, 48, 64 Pixeln ab, je nach Ort und
# Skalierung. Gibt man ihm nur ein grosses Bild und laesst es rechnen, landen
# die Striche zwischen den Pixelreihen und werden als graue Haelften gezeichnet.
# Genau daran – nicht an der Zeichnung – hing der Unterschied zu den Nachbarn in
# der Leiste, die ihre kleinen Groessen selbst mitliefern.
#
# Geschrieben werden:
#   src-tauri/icons/tray/    16/20/24/32 px, beide Zustaende (Tray, per include_image!)
#   src-tauri/icons/window/  32/40/48/64 px, beide Zustaende (Taskleiste, per set_icon)
#   src-tauri/icons/icon.ico 16..256 px in einer Datei (EXE, Installer, Explorer)
#   static/favicon.png
#
# Die uebrigen PNG/ICNS-Dateien und die Android-/iOS-Saetze kommen aus `tauri icon`.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$repo = Split-Path -Parent $PSScriptRoot
$src = Join-Path $repo "src-tauri\icons\source"
$icons = Join-Path $repo "src-tauri\icons"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "timetracker-icons"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Force -Path $tmp, (Join-Path $icons "tray") | Out-Null

# --- Rendern -----------------------------------------------------------------
# `tauri icon` rastert die SVG in seinen festen Groessen; alles Weitere rechnen
# wir aus der groessten davon herunter. Ein Vergleich mit direkt in Zielgroesse
# gezeichneten Bildern zeigte keinen Unterschied - die Geometrie muss also nicht
# ein zweites Mal in diesem Skript stehen.
function Render($svg, $outDir) {
    Push-Location $repo
    try { & npx tauri icon $svg -o $outDir 2>&1 | Out-Null } finally { Pop-Location }
}

function Scale($sourcePng, $size, $targetPng) {
    $img = [System.Drawing.Image]::FromFile($sourcePng)
    try {
        $bmp = New-Object System.Drawing.Bitmap $size, $size
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = "HighQualityBicubic"
        $g.PixelOffsetMode = "HighQuality"
        $g.DrawImage($img, 0, 0, $size, $size)
        $g.Dispose()
        $bmp.Save($targetPng, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
    } finally { $img.Dispose() }
}

Write-Host "Rendere Quellen ..."
Render (Join-Path $src "icon.svg") $icons                      # ruhend -> src-tauri/icons (alle Plattformen)
Render (Join-Path $src "icon-running.svg") (Join-Path $tmp "run")

# Groesste Fassung je Zustand (256 px); alle Zielgroessen entstehen daraus.
$idleGross = Join-Path $icons "128x128@2x.png"
$runGross = Join-Path $tmp "run\128x128@2x.png"

# --- Tray: je Zustand vier echte Groessen ------------------------------------
# Windows fragt je nach Skalierung 16 (100 %), 20 (125 %), 24 (150 %) oder 32 px
# (200 %) ab. lib.rs waehlt zur Laufzeit ueber GetSystemMetrics(SM_CXSMICON).
Write-Host "Schreibe Tray-Groessen ..."
foreach ($size in 16, 20, 24, 32) {
    Scale $idleGross $size (Join-Path $icons "tray\idle-$size.png")
    Scale $runGross $size (Join-Path $icons "tray\running-$size.png")
}

# --- Fenster-Icon: dieselben zwei Zustaende fuer die Taskleiste ---------------
# Die Taskleiste zeigt das Icon des Fensters, nicht das des Trays, und fragt es
# in SM_CXICON ab: 32 px bei 100 % Skalierung, 40 bei 125, 48 bei 150, 64 bei 200.
Write-Host "Schreibe Fenster-Groessen ..."
New-Item -ItemType Directory -Force -Path (Join-Path $icons "window") | Out-Null
foreach ($size in 32, 40, 48, 64) {
    Scale $idleGross $size (Join-Path $icons "window\idle-$size.png")
    Scale $runGross $size (Join-Path $icons "window\running-$size.png")
}

# --- icon.ico ----------------------------------------------------------------
# Aufbau: ICONDIR (6 Byte) + je Bild ein ICONDIRENTRY (16 Byte) + die PNG-Daten
# am Stueck. PNG-Eintraege in einer .ico versteht Windows seit Vista; Tauri
# unterstuetzt ohnehin erst Windows 10 aufwaerts.
#
# Alle Groessen aus derselben Zeichnung, aber jede einzeln gerechnet - das ist
# der Punkt der Datei: Windows muss nichts mehr skalieren.
Write-Host "Baue icon.ico ..."
$eintraege = @()
foreach ($size in 16, 20, 24, 32, 48, 64, 128, 256) { $eintraege += @{ Size = $size; Quelle = $idleGross } }

$bilder = foreach ($e in $eintraege) {
    $png = Join-Path $tmp "ico-$($e.Size).png"
    Scale $e.Quelle $e.Size $png
    , [System.IO.File]::ReadAllBytes($png)
}

$ms = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $ms
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$eintraege.Count)
$offset = 6 + 16 * $eintraege.Count
for ($i = 0; $i -lt $eintraege.Count; $i++) {
    $size = $eintraege[$i].Size
    # 256 wird als 0 geschrieben - ein Byte fasst die Groesse sonst nicht.
    $w.Write([byte]($size % 256)); $w.Write([byte]($size % 256))
    $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$bilder[$i].Length); $w.Write([uint32]$offset)
    $offset += $bilder[$i].Length
}
foreach ($b in $bilder) { $w.Write($b) }
$w.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $icons "icon.ico"), $ms.ToArray())
$w.Dispose(); $ms.Dispose()

# Gegenprobe. Eine kaputte .ico faellt sonst erst im Installer auf oder, schlimmer,
# gar nicht - Windows zeigt dann still das Standard-Programmsymbol.
#
# Geprueft wird das Verzeichnis selbst: steht jede erwartete Groesse drin, liegen
# ihre Daten innerhalb der Datei, und ist jeder Eintrag wirklich ein PNG? Die
# alte GDI+-Schnittstelle (System.Drawing.Icon) taugt dafuer nicht: sie liefert
# fuer den 256er-Eintrag, dessen Breite laut Format als 0 kodiert wird, das
# naechstkleinere Bild zurueck - eine korrekte Datei saehe damit kaputt aus.
$ico = [System.IO.File]::ReadAllBytes((Join-Path $icons "icon.ico"))
if ([BitConverter]::ToUInt16($ico, 2) -ne 1) { throw "icon.ico: kein Icon-Verzeichnis" }
$anzahl = [BitConverter]::ToUInt16($ico, 4)
if ($anzahl -ne $eintraege.Count) { throw "icon.ico: $anzahl Eintraege statt $($eintraege.Count)" }
for ($i = 0; $i -lt $anzahl; $i++) {
    $p = 6 + 16 * $i
    $breite = if ($ico[$p] -eq 0) { 256 } else { $ico[$p] }
    $laenge = [BitConverter]::ToUInt32($ico, $p + 8)
    $start = [BitConverter]::ToUInt32($ico, $p + 12)
    if ($breite -ne $eintraege[$i].Size) { throw "icon.ico: Eintrag $i ist $breite px statt $($eintraege[$i].Size)" }
    if ($start + $laenge -gt $ico.Length) { throw "icon.ico: Eintrag $breite px zeigt hinter das Dateiende" }
    # PNG-Signatur \x89PNG
    if ($ico[$start] -ne 0x89 -or $ico[$start + 1] -ne 0x50) { throw "icon.ico: Eintrag $breite px ist kein PNG" }
}

Copy-Item (Join-Path $icons "128x128.png") (Join-Path $repo "static\favicon.png") -Force
Copy-Item (Join-Path $icons "icon.ico") (Join-Path $repo "static\favicon.ico") -Force
Remove-Item $tmp -Recurse -Force
Write-Host "Fertig: icons/tray, icons/window, icon.ico, die PNG/ICNS-Saetze, static/favicon.png, static/favicon.ico"
