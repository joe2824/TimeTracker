# Outlook-COM-Bruecke fuer TimeTracker
# Wird von Rust (src-tauri/src/outlook.rs) aufgerufen.
#   -Action draft    : erstellt einen E-Mail-Entwurf und zeigt ihn an (kein automatischer Versand)
#   -Action calendar : liest Kalendereintraege im Zeitraum und gibt sie als JSON aus
#   -Action detect   : meldet als JSON, welche Outlook-Variante verfuegbar/aktiv ist (kein COM-Aufruf)
param(
  [Parameter(Mandatory = $true)][ValidateSet('draft', 'calendar', 'detect')][string]$Action,
  [string]$To = '',
  [string]$Subject = '',
  [string]$BodyFile = '',
  [string]$Start = '',
  [string]$End = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# Outlook lehnt COM-Aufrufe ab, wenn es beschaeftigt ist oder gerade startet
# (RPC_E_CALL_REJECTED 0x80010001, RPC_E_SERVERCALL_RETRYLATER 0x8001010A).
# Daher mit kurzem Backoff erneut versuchen.
function Invoke-WithRetry {
  param([scriptblock]$Action, [int]$Retries = 15, [int]$DelayMs = 400)
  for ($i = 0; $i -lt $Retries; $i++) {
    try {
      return & $Action
    }
    catch [System.Runtime.InteropServices.COMException] {
      $code = '0x{0:X8}' -f ($_.Exception.HResult -band 0xFFFFFFFF)
      if ($code -eq '0x80010001' -or $code -eq '0x8001010A') {
        Start-Sleep -Milliseconds $DelayMs
        continue
      }
      throw
    }
  }
  throw "Outlook ist beschäftigt und antwortet nicht. Bitte offene Outlook-Dialoge schließen und erneut versuchen."
}

function Get-Outlook {
  # Bestehende Instanz wiederverwenden, sonst neue starten.
  try { return [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') }
  catch {
    try { return New-Object -ComObject Outlook.Application }
    catch {
      # Klassisches Outlook (COM) ist nicht installiert/registriert - typischerweise
      # nutzt der Anwender nur das neue Outlook (Store-App). Klartext statt HRESULT.
      throw "Kein klassisches Outlook verfügbar. Die COM-Integration (Entwurf/Kalender) braucht das klassische Outlook mit eingerichtetem Profil. Mit dem neuen Outlook (Store-App) steht nur der Mail-Fallback zur Verfügung."
    }
  }
}

# Ermittelt ohne COM-Start, welche Outlook-Variante vorhanden/aktiv ist.
function Get-OutlookInfo {
  $classicCom = Test-Path 'Registry::HKEY_CLASSES_ROOT\Outlook.Application\CLSID'
  $newOutlook = [bool](Get-AppxPackage -Name Microsoft.OutlookForWindows -ErrorAction SilentlyContinue)

  # Installierte Office-Versionen (16.0, 15.0, ...) einmal ermitteln.
  $officeVersions = @(Get-ChildItem 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Office' -ErrorAction SilentlyContinue |
    Where-Object { $_.PSChildName -match '^\d+\.\d+$' })

  # Klassisches Profil unter irgendeiner Office-Version ODER dem versionsunabhaengigen WMS-Pfad.
  $profileRoots = [System.Collections.Generic.List[string]]::new()
  $profileRoots.Add('Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows NT\CurrentVersion\Windows Messaging Subsystem\Profiles')
  foreach ($ver in $officeVersions) { $profileRoots.Add("$($ver.PSPath)\Outlook\Profiles") }
  $hasProfile = $false
  foreach ($root in $profileRoots) {
    if (@(Get-ChildItem $root -ErrorAction SilentlyContinue).Count -gt 0) { $hasProfile = $true; break }
  }

  # "UseNewOutlook"=1 heisst: Anwender hat auf das neue Outlook umgeschaltet.
  $prefersNew = $false
  foreach ($ver in $officeVersions) {
    $v = (Get-ItemProperty "$($ver.PSPath)\Outlook\Preferences" -Name UseNewOutlook -ErrorAction SilentlyContinue).UseNewOutlook
    if ($v -eq 1) { $prefersNew = $true }
  }

  # comUsable: klassisches Outlook registriert UND ein Profil vorhanden -> COM sollte klappen.
  [PSCustomObject]@{
    classicComRegistered = [bool]$classicCom
    classicProfile       = [bool]$hasProfile
    newOutlookInstalled  = [bool]$newOutlook
    prefersNewOutlook    = [bool]$prefersNew
    comUsable            = [bool]($classicCom -and $hasProfile)
  }
}

if ($Action -eq 'detect') {
  Write-Output (ConvertTo-Json -InputObject (Get-OutlookInfo) -Depth 3 -Compress)
  exit 0
}

if ($Action -eq 'draft') {
  $body = ''
  if ($BodyFile -and (Test-Path -LiteralPath $BodyFile)) {
    $body = Get-Content -LiteralPath $BodyFile -Raw -Encoding UTF8
  }
  Invoke-WithRetry -Action {
    $ol = Get-Outlook
    $mail = $ol.CreateItem(0)            # olMailItem
    if ($To) { $mail.To = $To }
    $mail.Subject = $Subject
    $mail.HTMLBody = $body
    $mail.Display($false)                # Entwurf anzeigen, nicht senden
  }
  Write-Output 'ok'
  exit 0
}

if ($Action -eq 'calendar') {
  $startDt = [DateTime]::Parse($Start).Date
  # Ende EINSCHLIESSLICH: "2026-07-31" parst zu 31.07. 00:00, der Filter unten ist
  # <= – ohne das Tagesende fehlte jeder Termin am Monatsletzten im Import.
  $endDt = [DateTime]::Parse($End).Date.AddDays(1).AddSeconds(-1)

  $result = Invoke-WithRetry -Action {
    $ol = Get-Outlook
    $ns = $ol.GetNamespace('MAPI')
    try { $ns.Logon($null, $null, $false, $false) } catch {}
    $cal = $ns.GetDefaultFolder(9)       # olFolderCalendar
    $items = $cal.Items
    $items.IncludeRecurrences = $true
    $items.Sort('[Start]')
    $filter = "[Start] >= '" + $startDt.ToString('g') + "' AND [Start] <= '" + $endDt.ToString('g') + "'"
    $restricted = $items.Restrict($filter)

    $acc = @()
    foreach ($appt in $restricted) {
      $acc += [PSCustomObject]@{
        subject         = [string]$appt.Subject
        start           = $appt.Start.ToString('o')
        end             = $appt.End.ToString('o')
        allDay          = [bool]$appt.AllDayEvent
        categories      = [string]$appt.Categories
        busyStatus      = [int]$appt.BusyStatus    # 0 frei,1 vorbehalt,2 gebucht,3 abwesend,4 woanders
        durationMinutes = [int]$appt.Duration
      }
    }
    $acc
  }

  # @(...) erzwingt ein Array: PowerShell entpackt ein leeres Ergebnis zu $null
  # (ConvertTo-Json -> "null", was die alte '[]'-Wache nicht abfing und zu "[null]"
  # aufgeblasen wurde) und ein einzelnes Objekt zu einem Objekt statt einer Liste.
  $json = ConvertTo-Json -InputObject @($result) -Depth 4
  if (-not $json -or $json -eq 'null') { $json = '[]' }
  Write-Output $json
  exit 0
}
