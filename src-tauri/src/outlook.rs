use std::process::Command;
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Das PowerShell-Skript wird zur Compile-Zeit eingebettet und zur Laufzeit
// in den Cache-Ordner geschrieben. So funktioniert es in Dev und im Bundle gleich.
const OUTLOOK_PS1: &str = include_str!("../resources/outlook.ps1");

fn ensure_script(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("outlook.ps1");
    std::fs::write(&path, OUTLOOK_PS1).map_err(|e| e.to_string())?;
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
#[tauri::command]
pub fn create_outlook_draft(
    app: tauri::AppHandle,
    to: String,
    subject: String,
    html_body: String,
) -> Result<String, String> {
    let script = ensure_script(&app)?;
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let body_file = dir.join("draft-body.html");
    std::fs::write(&body_file, html_body).map_err(|e| e.to_string())?;

    let output = powershell(&script)
        .args(["-Action", "draft", "-To", &to, "-Subject", &subject])
        .arg("-BodyFile")
        .arg(&body_file)
        .output()
        .map_err(|e| format!("PowerShell konnte nicht gestartet werden: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Liest Kalendereintraege im Zeitraum [start, end] (ISO-Datum) und gibt sie als JSON-Array zurueck.
#[tauri::command]
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
