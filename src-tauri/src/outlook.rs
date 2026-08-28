//! Outlook ueber ein PowerShell-Skript (COM), je Aufruf ein eigener Prozess.
use std::process::Command;
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Das PowerShell-Skript wird zur Compile-Zeit eingebettet und zur Laufzeit
// in den Cache-Ordner geschrieben. So funktioniert es in Dev und im Bundle gleich.
const OUTLOOK_PS1: &str = include_str!("../resources/outlook.ps1");

/// Pfad zum ausgepackten Skript – geschrieben wird es einmal je Prozessstart.
fn ensure_script(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    static WRITTEN: std::sync::Mutex<bool> = std::sync::Mutex::new(false);

    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let path = dir.join("outlook.ps1");
    let mut written = WRITTEN.lock().unwrap_or_else(|e| e.into_inner());
    if *written {
        return Ok(path);
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // MIT BOM schreiben: `powershell.exe` (Windows PowerShell 5.1) liest eine
    // .ps1 ohne BOM als ANSI, nicht als UTF-8 - deutsche Umlaute in Meldungen
    // kaemen sonst verstuemmelt beim Benutzer an.
    let mut bytes = Vec::with_capacity(OUTLOOK_PS1.len() + 3);
    bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    bytes.extend_from_slice(OUTLOOK_PS1.as_bytes());
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    *written = true;
    Ok(path)
}

fn powershell(script: &std::path::Path) -> Command {
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ])
    .arg(script);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Erstellt einen Outlook-E-Mail-Entwurf (Empfaenger/Betreff/HTML-Body) und zeigt ihn an.
/// Sendet nicht automatisch - der Nutzer prueft und klickt selbst auf Senden.
#[tauri::command(async)]
pub fn create_outlook_draft(
    app: tauri::AppHandle,
    to: String,
    subject: String,
    html_body: String,
) -> Result<String, String> {
    let script = ensure_script(&app)?;
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    // Eigene Datei je Aufruf: zwei Entwuerfe gleichzeitig (der Monatsbericht und
    // eine Nachfrage aus dem Chef-Modus) schrieben sich sonst in dieselbe Datei,
    // und der zweite Entwurf oeffnete sich mit dem Text des ersten.
    static NR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let body_file = dir.join(format!(
        "draft-body-{}.html",
        NR.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::write(&body_file, html_body).map_err(|e| e.to_string())?;

    let output = powershell(&script)
        .args(["-Action", "draft", "-To", &to, "-Subject", &subject])
        .arg("-BodyFile")
        .arg(&body_file)
        .output()
        .map_err(|e| format!("PowerShell konnte nicht gestartet werden: {e}"));

    // Das Skript hat den Text laengst gelesen; liegen bleiben soll er nicht, sonst
    // sammelt der Cache-Ordner jeden je verschickten Bericht.
    let _ = std::fs::remove_file(&body_file);
    let output = output?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Meldet ohne COM-Aufruf, welche Outlook-Variante verfuegbar/aktiv ist.
/// Wird vom Frontend genutzt, um bei fehlendem klassischem Outlook einen klaren
/// Hinweis (statt eines kryptischen COM-Fehlers) und den mailto-Fallback anzubieten.
#[tauri::command(async)]
pub fn detect_outlook(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let script = ensure_script(&app)?;
    let output = powershell(&script)
        .args(["-Action", "detect"])
        .output()
        .map_err(|e| format!("PowerShell konnte nicht gestartet werden: {e}"))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        serde_json::from_str(stdout.trim())
            .map_err(|e| format!("JSON konnte nicht gelesen werden: {e}; Ausgabe: {stdout}"))
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Liest Mails des Posteingangs im Zeitraum [start, end] (ISO-Datum), gefiltert
/// auf einen Betreff-Teilstring. Fuer den Chef-Modus: die eingegangenen
/// Monatsberichte des Teams.
#[tauri::command(async)]
pub fn read_outlook_mails(
    app: tauri::AppHandle,
    start: String,
    end: String,
    subject_filter: String,
    subfolders: bool,
    max: u32,
) -> Result<serde_json::Value, String> {
    let script = ensure_script(&app)?;
    let max = max.clamp(1, 2000).to_string();
    let mut cmd = powershell(&script);
    cmd.args(["-Action", "mails", "-Start", &start, "-End", &end])
        .args(["-SubjectFilter", &subject_filter])
        .args(["-Max", &max]);
    if subfolders {
        cmd.arg("-Subfolders");
    }

    let output = cmd
        .output()
        .map_err(|e| format!("PowerShell konnte nicht gestartet werden: {e}"))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        serde_json::from_str(stdout.trim()).map_err(|e| {
            // Die Ausgabe kann hier Megabytes gross sein (Mail-Bodies) - nur den
            // Anfang in die Meldung, sonst sprengt ein Fehler jeden Toast und jede
            // Protokollzeile.
            let head: String = stdout.chars().take(400).collect();
            format!("JSON konnte nicht gelesen werden: {e}; Ausgabe: {head}")
        })
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Liest Kalendereintraege im Zeitraum [start, end] (ISO-Datum) und gibt sie als JSON-Array zurueck.
#[tauri::command(async)]
pub fn read_outlook_calendar(
    app: tauri::AppHandle,
    start: String,
    end: String,
) -> Result<serde_json::Value, String> {
    let script = ensure_script(&app)?;
    let output = powershell(&script)
        .args(["-Action", "calendar", "-Start", &start, "-End", &end])
        .output()
        .map_err(|e| format!("PowerShell konnte nicht gestartet werden: {e}"))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        serde_json::from_str(stdout.trim())
            .map_err(|e| format!("JSON konnte nicht gelesen werden: {e}; Ausgabe: {stdout}"))
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}
