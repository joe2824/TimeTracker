# Outlook-COM-Bruecke fuer TimeTracker
# Wird von Rust (src-tauri/src/outlook.rs) aufgerufen.
#   -Action draft    : erstellt einen E-Mail-Entwurf und zeigt ihn an (kein automatischer Versand)
#   -Action calendar : liest Kalendereintraege im Zeitraum und gibt sie als JSON aus
param(
  [Parameter(Mandatory = $true)][ValidateSet('draft', 'calendar')][string]$Action,
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
  catch { return New-Object -ComObject Outlook.Application }
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
  $startDt = [DateTime]::Parse($Start)
  $endDt = [DateTime]::Parse($End)

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

  $json = ConvertTo-Json -InputObject $result -Depth 4
  if (-not $json) { $json = '[]' }
  elseif ($json[0] -ne '[') { $json = "[$json]" }   # PS 5.1 entpackt Einzel-Objekt
  Write-Output $json
  exit 0
}
