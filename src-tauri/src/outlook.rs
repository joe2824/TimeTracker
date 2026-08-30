//! Outlook ueber ein PowerShell-Skript (COM) unter Windows bzw. sauberer Fallback auf anderen Plattformen.

#[cfg(windows)]
mod imp {
    use std::process::Command;
    use std::os::windows::process::CommandExt;
    use tauri::Manager;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const OUTLOOK_PS1: &str = include_str!("../resources/outlook.ps1");

    fn ensure_script(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
        static WRITTEN: std::sync::Mutex<bool> = std::sync::Mutex::new(false);

        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
        let path = dir.join("outlook.ps1");
        let mut written = WRITTEN.lock().unwrap_or_else(|e| e.into_inner());
        if *written {
            return Ok(path);
        }
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
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
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }

    pub fn create_outlook_draft(
        app: tauri::AppHandle,
        to: String,
        subject: String,
        html_body: String,
    ) -> Result<String, String> {
        let script = ensure_script(&app)?;
        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
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

        let _ = std::fs::remove_file(&body_file);
        let output = output?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }

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
                let head: String = stdout.chars().take(400).collect();
                format!("JSON konnte nicht gelesen werden: {e}; Ausgabe: {head}")
            })
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }

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
}

#[cfg(not(windows))]
mod imp {
    use tauri::AppHandle;

    pub fn create_outlook_draft(
        _app: AppHandle,
        _to: String,
        _subject: String,
        _html_body: String,
    ) -> Result<String, String> {
        Err("Outlook COM-Automatisierung ist nur unter Windows verfügbar".to_string())
    }

    pub fn detect_outlook(_app: AppHandle) -> Result<serde_json::Value, String> {
        Ok(serde_json::json!({
            "classicComRegistered": false,
            "classicProfile": false,
            "newOutlookInstalled": false,
            "prefersNewOutlook": false,
            "comUsable": false
        }))
    }

    pub fn read_outlook_mails(
        _app: AppHandle,
        _start: String,
        _end: String,
        _subject_filter: String,
        _subfolders: bool,
        _max: u32,
    ) -> Result<serde_json::Value, String> {
        Ok(serde_json::json!([]))
    }

    pub fn read_outlook_calendar(
        _app: AppHandle,
        _start: String,
        _end: String,
    ) -> Result<serde_json::Value, String> {
        Ok(serde_json::json!([]))
    }
}

/// Erstellt einen Outlook-E-Mail-Entwurf (Empfaenger/Betreff/HTML-Body) und zeigt ihn an.
#[tauri::command(async)]
pub fn create_outlook_draft(
    app: tauri::AppHandle,
    to: String,
    subject: String,
    html_body: String,
) -> Result<String, String> {
    imp::create_outlook_draft(app, to, subject, html_body)
}

/// Meldet, welche Outlook-Variante verfuegbar/aktiv ist.
#[tauri::command(async)]
pub fn detect_outlook(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    imp::detect_outlook(app)
}

/// Liest Mails des Posteingangs.
#[tauri::command(async)]
pub fn read_outlook_mails(
    app: tauri::AppHandle,
    start: String,
    end: String,
    subject_filter: String,
    subfolders: bool,
    max: u32,
) -> Result<serde_json::Value, String> {
    imp::read_outlook_mails(app, start, end, subject_filter, subfolders, max)
}

/// Liest Kalendereintraege im Zeitraum [start, end] (ISO-Datum).
#[tauri::command(async)]
pub fn read_outlook_calendar(
    app: tauri::AppHandle,
    start: String,
    end: String,
) -> Result<serde_json::Value, String> {
    imp::read_outlook_calendar(app, start, end)
}
