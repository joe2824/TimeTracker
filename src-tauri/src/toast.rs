// System-Benachrichtigungen, die sich anklicken lassen.

#[cfg(windows)]
fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Der Klick öffnet einen Deeplink. Er landet als zweite Instanz im
/// single-instance-Plugin, und das holt das Fenster nach vorn.
#[cfg(windows)]
fn toast_xml(title: &str, body: &str) -> String {
    format!(
        r#"<toast launch="{}open" activationType="protocol"><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual></toast>"#,
        crate::DEEP_LINK_PREFIX,
        escape_xml(title),
        escape_xml(body)
    )
}

/// Wie im Notification-Plugin: nur die installierte App hat eine eigene
/// AppUserModelID (über die Startmenü-Verknüpfung), ein Build aus `target\`
/// meldet sich als PowerShell - sonst zeigt Windows gar nichts an.
#[cfg(windows)]
fn app_id() -> String {
    let installed = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.to_path_buf()))
        .map(|dir| {
            let dir = dir.display().to_string();
            !(dir.ends_with("\\target\\debug") || dir.ends_with("\\target\\release"))
        })
        .unwrap_or(true);
    if installed {
        crate::IDENTIFIER.to_string()
    } else {
        "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"
            .to_string()
    }
}

/// Das Notification-Plugin gibt dem Toast unter Windows kein Klick-Ziel mit,
/// ein Klick darauf tat deshalb nichts. Protokoll-Aktivierung wirkt auch aus
/// dem Info-Center heraus, wenn die Meldung dort schon länger liegt.
#[cfg(windows)]
fn show_windows(title: &str, body: &str, tag: Option<&str>) -> windows::core::Result<()> {
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    let doc = XmlDocument::new()?;
    doc.LoadXml(&HSTRING::from(toast_xml(title, body)))?;
    let toast = ToastNotification::CreateToastNotification(&doc)?;
    if let Some(tag) = tag.filter(|t| !t.is_empty()) {
        // Gleicher Tag ersetzt die vorige Meldung; Windows erlaubt höchstens 64 Zeichen.
        let tag: String = tag.chars().take(64).collect();
        toast.SetTag(&HSTRING::from(tag))?;
    }
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id()))?.Show(&toast)
}

#[tauri::command]
pub fn show_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
    tag: Option<String>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = app;
        show_windows(&title, &body, tag.as_deref()).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = tag;
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| e.to_string())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn toast_opens_the_app_by_link() {
        let xml = toast_xml("Titel", "Text");
        assert!(xml.contains(r#"launch="timetracker://open""#));
        assert!(xml.contains(r#"activationType="protocol""#));
    }

    #[test]
    fn toast_escapes_user_text() {
        let xml = toast_xml("A & B", "<Projekt> \"x\"");
        assert!(xml.contains("A &amp; B"));
        assert!(xml.contains("&lt;Projekt&gt; &quot;x&quot;"));
    }
}
