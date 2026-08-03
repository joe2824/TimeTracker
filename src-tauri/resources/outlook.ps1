# Outlook-COM-Bruecke fuer TimeTracker
# Wird von Rust (src-tauri/src/outlook.rs) aufgerufen.
#   -Action draft    : erstellt einen E-Mail-Entwurf und zeigt ihn an (kein automatischer Versand)
#   -Action calendar : liest Kalendereintraege im Zeitraum und gibt sie als JSON aus
#   -Action mails    : liest Mails des Posteingangs im Zeitraum (Chef-Modus) und gibt sie als JSON aus
#   -Action detect   : meldet als JSON, welche Outlook-Variante verfuegbar/aktiv ist (kein COM-Aufruf)
param(
  [Parameter(Mandatory = $true)][ValidateSet('draft', 'calendar', 'mails', 'detect')][string]$Action,
  [string]$To = '',
  [string]$Subject = '',
  [string]$BodyFile = '',
  [string]$Start = '',
  [string]$End = '',
  # nur fuer -Action mails:
  [string]$SubjectFilter = '',
  [switch]$Subfolders,
  [int]$Max = 300
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

# Anzeigename des Absenders. Faellt auf die Adresse zurueck, damit eine Mail nie
# voellig namenlos in der Team-Uebersicht steht.
function Get-SenderName {
  param($mail)
  try {
    $n = [string]$mail.SenderName
    if ($n) { return $n }
  } catch {}
  try { return [string]$mail.SenderEmailAddress } catch { return '' }
}

# SMTP-Adresse des Absenders.
#
# Bei internen Exchange-Absendern liefert SenderEmailAddress KEINE Mailadresse,
# sondern den X500-Verzeichnisnamen ("/O=…/CN=RECIPIENTS/CN=Meier"). Genau die
# internen Absender sind aber das ganze Team – ohne diese Aufloesung passte kein
# einziger Bericht auf einen Eintrag der Teamliste.
function Get-SenderSmtp {
  param($mail)
  try {
    if ([string]$mail.SenderEmailType -eq 'EX') {
      try {
        $u = $mail.Sender.GetExchangeUser()
        if ($u -and $u.PrimarySmtpAddress) { return [string]$u.PrimarySmtpAddress }
      } catch {}
      try {
        # PR_SENT_REPRESENTING_SMTP_ADDRESS – greift auch, wenn der Absender nicht
        # mehr im Verzeichnis steht (ausgeschiedene Mitarbeiter).
        $smtp = [string]$mail.PropertyAccessor.GetProperty(
          'http://schemas.microsoft.com/mapi/proptag/0x5D01001E')
        if ($smtp) { return $smtp }
      } catch {}
    }
    return [string]$mail.SenderEmailAddress
  } catch { return '' }
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

if ($Action -eq 'mails') {
  $startDt = [DateTime]::Parse($Start).Date
  # Ende EINSCHLIESSLICH, wie beim Kalender: sonst fehlten alle Mails des letzten Tages.
  $endDt = [DateTime]::Parse($End).Date.AddDays(1).AddSeconds(-1)

  # Ein einzelner Body kann Megabytes gross sein (eingebettete Bilder als base64).
  # Fuer die Tabelle reicht der Anfang bei weitem – ungekappt stand die ganze
  # Postfach-Ausbeute als JSON in der Prozessausgabe.
  $maxBody = 200000

  $result = Invoke-WithRetry -Action {
    $ol = Get-Outlook
    $ns = $ol.GetNamespace('MAPI')
    try { $ns.Logon($null, $null, $false, $false) } catch {}
    $inbox = $ns.GetDefaultFolder(6)     # olFolderInbox

    # Zu durchsuchende Ordner sammeln: Posteingang, auf Wunsch mit Unterordnern
    # (viele lassen Berichts-Mails per Outlook-Regel dorthin einsortieren).
    $folders = [System.Collections.Generic.List[object]]::new()
    $folders.Add($inbox)
    if ($Subfolders) {
      $queue = [System.Collections.Generic.Queue[object]]::new()
      $queue.Enqueue($inbox)
      # Deckel gegen Postfaecher mit hunderten Ordnern - der Aufruf soll Sekunden dauern.
      while ($queue.Count -gt 0 -and $folders.Count -lt 50) {
        $cur = $queue.Dequeue()
        foreach ($sub in $cur.Folders) {
          # DefaultItemType 0 = olMailItem; Kalender/Kontakte gar nicht erst anfassen.
          if ($sub.DefaultItemType -ne 0) { continue }
          $folders.Add($sub)
          $queue.Enqueue($sub)
        }
      }
    }

    # Wildcards im Suchbegriff woertlich nehmen: ein getipptes "*" oder "[" machte
    # -like sonst zum Platzhalter und lieferte fremde Mails.
    $pattern = ''
    if ($SubjectFilter) {
      $pattern = '*' + [System.Management.Automation.WildcardPattern]::Escape($SubjectFilter) + '*'
    }

    $acc = @()
    $filter = "[ReceivedTime] >= '" + $startDt.ToString('g') + "' AND [ReceivedTime] <= '" + $endDt.ToString('g') + "'"
    foreach ($folder in $folders) {
      if ($acc.Count -ge $Max) { break }
      $items = $folder.Items
      $items.Sort('[ReceivedTime]', $true)
      $restricted = $items.Restrict($filter)
      foreach ($item in $restricted) {
        if ($acc.Count -ge $Max) { break }
        # 43 = olMail. Termin-Antworten und Berichte anderer Klassen haben weder
        # Absender-Adresse noch HTMLBody in der erwarteten Form.
        try { if ($item.Class -ne 43) { continue } } catch { continue }
        $subj = [string]$item.Subject
        if ($pattern -and ($subj -notlike $pattern)) { continue }

        # Kopf-only-Mails (Cached-Modus "nur Kopfzeilen") haben keinen Body. Das
        # Nachladen anstossen – ueber InvokeMember, weil PowerShell die Methode auf
        # einem spaet gebundenen COM-Objekt sonst nicht findet. Klappt nicht
        # ueberall; schlaegt es fehl, bleibt der Body leer und die App sagt es.
        try {
          if ($item.DownloadState -eq 1) {
            [void]$item.GetType().InvokeMember('Download', 'InvokeMethod', $null, $item, $null)
          }
        } catch {}

        $body = ''
        try { $body = [string]$item.HTMLBody } catch {}
        if (-not $body) { try { $body = [string]$item.Body } catch {} }
        if ($body.Length -gt $maxBody) { $body = $body.Substring(0, $maxBody) }

        $received = ''
        try { $received = $item.ReceivedTime.ToString('o') } catch {}

        $acc += [PSCustomObject]@{
          subject     = $subj
          senderName  = Get-SenderName $item
          senderEmail = Get-SenderSmtp $item
          received    = $received
          body        = $body
          folder      = [string]$folder.Name
        }
      }
    }
    $acc
  }

  # @(...) wie beim Kalender: sonst wird ein leeres Ergebnis zu "null" und ein
  # einzelnes Objekt zu einem Objekt statt einer Liste.
  $json = ConvertTo-Json -InputObject @($result) -Depth 4
  if (-not $json -or $json -eq 'null') { $json = '[]' }
  Write-Output $json
  exit 0
}
