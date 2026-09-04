mod outlook;
mod secret;

use tauri::{Emitter, Manager};


/// Muss zu `identifier` in tauri.conf.json passen: der Panic-Hook laeuft, bevor
/// es eine App-Instanz gibt, die den Pfad nennen koennte.
const IDENTIFIER: &str = "com.jklein.timetracker";

/// Datenordner der App – derselbe, den das Frontend ueber BaseDirectory::AppData
/// bekommt. Je Plattform ein anderer Ort, sonst schriebe der Rust-Teil sein
/// Protokoll woanders hin als das Frontend.
fn app_data_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(std::path::PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(|h| std::path::PathBuf::from(h).join("Library/Application Support"));
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share"))
        });
    Some(base?.join(IDENTIFIER))
}

/// Protokollordner – derselbe, in den das Frontend schreibt.
fn log_dir() -> Option<std::path::PathBuf> {
    Some(app_data_dir()?.join("logs"))
}

/// Eine Zeile an die heutige Protokolldatei anhaengen – im selben Format wie das
/// Frontend, damit sich beide Seiten in einer Datei zusammen lesen lassen.
///
/// Schluckt jeden Fehler: Protokollieren darf einen Absturz nicht verschlimmern.
fn log_line(level: &str, text: &str) {
    use std::io::Write;
    let Some(dir) = log_dir() else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let now = chrono::Local::now();
    let path = dir.join(format!("{}.log", now.format("%Y-%m-%d")));
    let line = format!(
        "{} rust {:<5} {}\n",
        now.format("%Y-%m-%d %H:%M:%S%.3f"),
        level,
        text
    );
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Abstuerze des Rust-Teils mitschreiben.
fn install_panic_logging() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let ort = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unbekannt".into());
        log_line("ERROR", &format!("Absturz im Rust-Teil ({ort}): {info}"));
        previous(info);
    }));
}

/// Update-Manifest des stabilen Kanals. Steht auch in tauri.conf.json – hier,
/// damit die Beta-Liste ihn als Rueckfall mitfuehren kann.
#[cfg(desktop)]
const UPDATE_STABLE: &str =
    "https://github.com/joe2824/timetracker/releases/latest/download/latest.json";

/// Update-Manifest des Beta-Kanals: ein Release mit festem Tag `beta`, dessen
/// Manifest jeder Build ueberschreibt – auch ein stabiler. Wer Betas anhat,
/// bekommt damit immer den neuesten Stand und bleibt nicht auf einer Vorabversion
/// sitzen, nur weil laengere Zeit keine neue Beta kam.
#[cfg(desktop)]
const UPDATE_BETA: &str = "https://github.com/joe2824/timetracker/releases/download/beta/latest.json";

/// Steht `betaUpdates` in den Einstellungen auf true? Die Datei selbst gelesen: die
/// Endpunkte muessen stehen, BEVOR das Updater-Plugin seine Konfiguration liest.
#[cfg(desktop)]
fn beta_updates_enabled() -> bool {
    let Some(path) = app_data_dir().map(|d| d.join("data").join("settings.json")) else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("betaUpdates").and_then(serde_json::Value::as_bool))
        .unwrap_or(false)
}

/// Den Beta-Kanal in die Updater-Konfiguration eintragen, bevor das Plugin sie
/// liest. Stabil bleibt als zweiter Eintrag der Rueckfall.
#[cfg(desktop)]
fn use_beta_channel(context: &mut tauri::Context) {
    let Some(updater) = context.config_mut().plugins.0.get_mut("updater") else {
        return;
    };
    let Some(obj) = updater.as_object_mut() else {
        return;
    };
    obj.insert(
        "endpoints".into(),
        serde_json::json!([UPDATE_BETA, UPDATE_STABLE]),
    );
    log_line("INFO", "Update-Kanal: Beta");
}

#[derive(serde::Deserialize, Clone, PartialEq, Eq, Debug)]
pub struct TrayActivity {
    id: String,
    name: String,
    #[serde(default)]
    favorite: bool,
}

#[derive(serde::Deserialize, Default, Clone, PartialEq, Eq, Debug)]
pub struct TrayState {
    /// Name der laufenden Aktivitaet, falls ein Timer laeuft.
    running: Option<String>,
    /// Schnellstart-Liste (Favoriten zuerst, dann zuletzt benutzte).
    activities: Vec<TrayActivity>,
}

#[cfg(desktop)]
fn build_tray_menu(
    app: &tauri::AppHandle,
    state: &TrayState,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};

    let mut b = MenuBuilder::new(app);

    // Laufender Timer oben + Stop-Button (wie OneDrive den Status zeigt).
    if let Some(name) = &state.running {
        b = b
            .item(
                &MenuItemBuilder::with_id("running", format!("● {name} läuft"))
                    .enabled(false)
                    .build(app)?,
            )
            .item(&MenuItemBuilder::with_id("stop", "■ Timer stoppen").build(app)?)
            .separator();
    }

    // Schnellstart: Favoriten + zuletzt benutzte direkt anklickbar.
    if !state.activities.is_empty() {
        b = b.item(
            &MenuItemBuilder::with_id("qs_header", "Schnellstart")
                .enabled(false)
                .build(app)?,
        );
        for a in &state.activities {
            let star = if a.favorite { "★ " } else { "▶ " };
            b = b.item(
                &MenuItemBuilder::with_id(format!("start:{}", a.id), format!("{star}{}", a.name))
                    .build(app)?,
            );
        }
        b = b.separator();
    }

    b.item(&MenuItemBuilder::with_id("show", "App öffnen").build(app)?)
        .item(&MenuItemBuilder::with_id("quit", "Beenden").build(app)?)
        .build()
}

#[cfg(desktop)]
fn handle_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    if let Some(act) = id.strip_prefix("start:") {
        // Timer im Hintergrund starten, ohne Fenster zu oeffnen.
        let _ = app.emit("tray-start-activity", act.to_string());
        return;
    }
    match id {
        "show" => show_main(app),
        "stop" => {
            let _ = app.emit("tray-stop-timer", ());
        }
        "quit" => request_quit(app),
        _ => {}
    }
}

/// Das Flyout-Fenster – vorhandenes zurueckgeben, sonst aus seinem Config-Block bauen.
/// Steht in tauri.conf.json auf `"create": false` - sonst baut jeder Prozessstart ein
/// zweites WebView2 samt Frontend auf.
#[cfg(desktop)]
fn tray_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    // Ein Bauvorgang zur Zeit: zwei Anlaesse dicht hintereinander (erster
    // set_tray_state und ein Klick aufs Tray-Icon) liefen sonst beide in den Bau,
    // und der zweite scheiterte am schon vergebenen Label.
    static BUILDING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = BUILDING.lock().unwrap_or_else(|e| e.into_inner());

    if let Some(win) = app.get_webview_window("tray") {
        return Some(win);
    }
    let config = app.config().app.windows.iter().find(|w| w.label == "tray")?.clone();
    match tauri::WebviewWindowBuilder::from_config(app, &config).and_then(|b| b.build()) {
        Ok(win) => Some(win),
        Err(e) => {
            log_line("ERROR", &format!("Flyout-Fenster nicht anlegbar: {e}"));
            None
        }
    }
}

/// Etwas mit dem Flyout-Fenster tun – auf einem eigenen Thread, und das Fenster
/// bauen, falls es noch nicht steht.
#[cfg(desktop)]
fn with_tray_window(app: &tauri::AppHandle, f: impl FnOnce(tauri::WebviewWindow) + Send + 'static) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(win) = tray_window(&app) {
            f(win);
        }
    });
}

/// Positioniert das Flyout nahe der Klickposition (über dem Cursor) und zeigt es.
#[cfg(desktop)]
fn toggle_flyout(app: &tauri::AppHandle, click: tauri::PhysicalPosition<f64>) {
    with_tray_window(app, move |win| {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            return;
        }
        if let Ok(size) = win.outer_size() {
            let mut x = click.x - size.width as f64 / 2.0;
            #[cfg(target_os = "macos")]
            let mut y = click.y + 8.0; // Unter der Menüleiste (macOS)
            #[cfg(not(target_os = "macos"))]
            let mut y = click.y - size.height as f64 - 8.0; // Über der Taskleiste (Windows/Linux)
            // grob auf den sichtbaren Bereich des Monitors klemmen
            if let Ok(Some(monitor)) = win.current_monitor() {
                let mp = monitor.position();
                let ms = monitor.size();
                let min_x = mp.x as f64;
                let max_x = mp.x as f64 + ms.width as f64 - size.width as f64;
                let min_y = mp.y as f64;
                let max_y = mp.y as f64 + ms.height as f64 - size.height as f64;
                x = x.clamp(min_x, max_x.max(min_x));
                y = y.clamp(min_y, max_y.max(min_y));
            } else {
                x = x.max(0.0);
                y = y.max(0.0);
            }
            let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        }
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.emit("tray-shown", ());
    });
}

#[cfg(desktop)]
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let menu = build_tray_menu(app.handle(), &TrayState::default())?;

    // Links-Klick öffnet das Flyout-Fenster, Rechts-Klick das native Menü (Fallback).
    TrayIconBuilder::with_id("main")
        // Dasselbe Bild wie im ruhenden Zustand von set_tray_state – nicht das
        // Fenster-Icon: sonst wechselte das Tray beim ersten Timer die Groesse
        // mit, weil beide Zustaende aus verschiedenen Quellen kaemen.
        .icon(tray_icon(false))
        .tooltip("TimeTracker")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                position,
                ..
            } = event
            {
                toggle_flyout(tray.app_handle(), position);
            }
        })
        .build(app)?;
    Ok(())
}

/// Das Tray-Icon in beiden Zustaenden und vier Groessen.
#[cfg(desktop)]
fn tray_icon(running: bool) -> tauri::image::Image<'static> {
    // Groesse, in der das System das Icon zeichnet. Aendert sich nur mit der
    // Skalierung, also faktisch nie waehrend des Betriebs.
    #[cfg(windows)]
    let px = {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSMICON};
        match unsafe { GetSystemMetrics(SM_CXSMICON) } {
            n if n > 0 => n as u32,
            _ => 16,
        }
    };
    // macOS/Linux skalieren selbst und erwarten das grosse Bild.
    #[cfg(not(windows))]
    let px = 32;

    match (running, px) {
        (false, 0..=16) => tauri::include_image!("icons/tray/idle-16.png"),
        (false, 17..=20) => tauri::include_image!("icons/tray/idle-20.png"),
        (false, 21..=24) => tauri::include_image!("icons/tray/idle-24.png"),
        (false, _) => tauri::include_image!("icons/tray/idle-32.png"),
        (true, 0..=16) => tauri::include_image!("icons/tray/running-16.png"),
        (true, 17..=20) => tauri::include_image!("icons/tray/running-20.png"),
        (true, 21..=24) => tauri::include_image!("icons/tray/running-24.png"),
        (true, _) => tauri::include_image!("icons/tray/running-32.png"),
    }
}

/// Dasselbe fuer das Fenster – also fuer die Taskleiste.
#[cfg(desktop)]
fn window_icon(running: bool) -> tauri::image::Image<'static> {
    #[cfg(windows)]
    let px = {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXICON};
        match unsafe { GetSystemMetrics(SM_CXICON) } {
            n if n > 0 => n as u32,
            _ => 32,
        }
    };
    #[cfg(not(windows))]
    let px = 64;

    match (running, px) {
        (false, 0..=32) => tauri::include_image!("icons/window/idle-32.png"),
        (false, 33..=40) => tauri::include_image!("icons/window/idle-40.png"),
        (false, 41..=48) => tauri::include_image!("icons/window/idle-48.png"),
        (false, _) => tauri::include_image!("icons/window/idle-64.png"),
        (true, 0..=32) => tauri::include_image!("icons/window/running-32.png"),
        (true, 33..=40) => tauri::include_image!("icons/window/running-40.png"),
        (true, 41..=48) => tauri::include_image!("icons/window/running-48.png"),
        (true, _) => tauri::include_image!("icons/window/running-64.png"),
    }
}

/// Baut das Tray-Menue neu (laufender Timer + Schnellstart aus Favoriten/zuletzt benutzt).
#[tauri::command]
fn set_tray_state(app: tauri::AppHandle, state: TrayState) -> Result<(), String> {
    #[cfg(desktop)]
    {
        static LAST_STATE: std::sync::Mutex<Option<TrayState>> = std::sync::Mutex::new(None);
        let mut guard = LAST_STATE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref prev) = *guard {
            if prev == &state {
                return Ok(());
            }
        }
        *guard = Some(state.clone());
    }

    #[cfg(desktop)]
    if let Some(tray) = app.tray_by_id("main") {
        let menu = build_tray_menu(&app, &state).map_err(|e| e.to_string())?;
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;

        // Tray-Icon: laufender Timer = geschlossener Ring in Terrakotta.
        let _ = tray.set_icon(Some(tray_icon(state.running.is_some())));
    }

    // Und dasselbe am Fenster, damit die Taskleiste den laufenden Timer ebenso
    // zeigt wie das Tray. Beide Fenster: das Flyout steht zwar nicht in der
    // Leiste (skipTaskbar), aber sein Icon taucht in Alt-Tab-Ersatzoberflaechen
    // und Aufnahme-Dialogen auf.
    #[cfg(desktop)]
    {
        let icon = window_icon(state.running.is_some());
        for label in ["main", "tray"] {
            if let Some(win) = app.get_webview_window(label) {
                let _ = win.set_icon(icon.clone());
            }
        }
    }
    // Gelegenheit, das Flyout-Fenster nachzuziehen: dieser Aufruf kommt aus dem
    // Hauptfenster, sobald dessen Daten stehen. Das Fenster entsteht damit NACH
    // dem Start statt mitten hinein, und der erste Klick aufs Tray-Icon muss
    // trotzdem nicht darauf warten.
    #[cfg(desktop)]
    with_tray_window(&app, |_| {});
    #[cfg(not(desktop))]
    let _ = (app, state);
    Ok(())
}

/// Sekunden seit der letzten Tastatur-/Maus-Eingabe (Leerlauf-Erkennung).
#[tauri::command]
fn idle_seconds() -> u64 {
    #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
    {
        match user_idle::UserIdle::get_time() {
            Ok(t) => t.as_seconds(),
            Err(_) => 0,
        }
    }
    #[cfg(not(all(desktop, not(any(target_os = "android", target_os = "ios")))))]
    {
        0
    }
}

/// Schreibt Text an einen frei gewaehlten Pfad – fuer den CSV-Export aus dem
/// Chef-Modus, dessen Ziel aus dem Speichern-Dialog kommt.
#[tauri::command]
fn write_export_file(path: String, contents: String) -> Result<(), String> {
    let mut bytes = Vec::with_capacity(contents.len() + 3);
    bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    bytes.extend_from_slice(contents.as_bytes());
    std::fs::write(&path, bytes).map_err(|e| format!("{path} konnte nicht geschrieben werden: {e}"))
}

/// Setzt den Tray-Tooltip (z.B. laufende Zeit "Projekt 1 – 1:23:45").

#[tauri::command]
fn set_tray_tooltip(app: tauri::AppHandle, text: String) -> Result<(), String> {
    #[cfg(desktop)]
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_tooltip(Some(&text)).map_err(|e| e.to_string())?;
    }
    #[cfg(not(desktop))]
    let _ = (app, text);
    Ok(())
}

/// Wie lange das Beenden auf den letzten Abgleich wartet.
///
/// Reicht fuer eine Handvoll Datensaetze ueber eine normale Leitung. Laenger
/// wartet niemand: ohne Netz oder mit haengender Oberflaeche muss "Beenden"
/// trotzdem beenden.
const QUIT_GRACE_MS: u64 = 3000;

/// Beenden, aber der Oberflaeche vorher kurz Zeit geben.
///
/// Sie laedt auf `app-quit` hin den letzten Stand hoch und ruft danach
/// `quit_now`. Der Wecker hier laeuft unabhaengig davon weiter - kommt die
/// Antwort nicht, wird trotzdem beendet.
#[cfg(desktop)]
fn request_quit(app: &tauri::AppHandle) {
    let _ = app.emit("app-quit", ());
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(QUIT_GRACE_MS));
        handle.exit(0);
    });
}

/// Die Oberflaeche ist fertig - jetzt wirklich beenden.
#[tauri::command]
fn quit_now(app: tauri::AppHandle) {
    app.exit(0);
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// „App öffnen" aus dem Flyout – derselbe Weg wie „Öffnen" im Tray-Menue.
#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    show_main(&app);
}

/// Flyout oeffnen wie ein Klick aufs Tray-Icon – fuer den Dev-Knopf in den
/// Einstellungen, der es sonst von Hand suchte und zeigte.
#[tauri::command]
fn show_flyout(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let pos = app.cursor_position().map_err(|e| e.to_string())?;
        toggle_flyout(&app, pos);
    }
    #[cfg(not(desktop))]
    let _ = app;
    Ok(())
}

/// Zweite Instanz abfangen, bevor Tauri irgendetwas aufbaut.
#[cfg(windows)]
fn enforce_single_instance() {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowW, IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE, SW_SHOW,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    // Bewusst ein eigener Name: wuerden wir den Mutex des Plugins anlegen, saehe
    // das Plugin im selben Prozess ERROR_ALREADY_EXISTS und die *erste* Instanz
    // hielte sich fuer die zweite.
    let mutex_name = wide(&format!("{IDENTIFIER}-guard"));
    // Handle absichtlich nicht schliessen: der Mutex soll genau so lange
    // existieren wie der Prozess. Windows raeumt ihn beim Beenden selbst ab.
    let _mutex = unsafe { CreateMutexW(std::ptr::null(), 0, mutex_name.as_ptr()) };
    if unsafe { GetLastError() } != ERROR_ALREADY_EXISTS {
        return; // Wir sind die erste Instanz.
    }

    // Ab hier laeuft schon jemand. Ist das Zielfenster des Plugins da, ist alles
    // gesund: weiterlaufen lassen, das Plugin holt gleich das Fenster der ersten
    // Instanz nach vorn und beendet uns sauber.
    let plugin_class = wide(&format!("{IDENTIFIER}-sic"));
    let plugin_title = wide(&format!("{IDENTIFIER}-siw"));
    if !unsafe { FindWindowW(plugin_class.as_ptr(), plugin_title.as_ptr()) }.is_null() {
        return;
    }

    // Kein Zielfenster – das Plugin wuerde uns jetzt durchlassen. Selbst pruefen,
    // ob die andere Instanz ueberhaupt noch ein Hauptfenster hat.
    let main_class = wide("Tauri Window");
    let main_title = wide("Time Tracker");
    let main = unsafe { FindWindowW(main_class.as_ptr(), main_title.as_ptr()) };
    if main.is_null() {
        // Kein Mutex-Besitzer mit Fenster: die andere Instanz faehrt gerade
        // herunter. Dann duerfen wir ihren Platz einnehmen.
        return;
    }

    // Fenster der laufenden Instanz nach vorn holen und uns beenden – das ist
    // das, was das Plugin hier haette tun sollen.
    unsafe {
        if IsIconic(main) != 0 {
            ShowWindow(main, SW_RESTORE);
        } else {
            ShowWindow(main, SW_SHOW);
        }
        SetForegroundWindow(main);
    }
    log_line(
        "WARN",
        "Zweite Instanz beendet (Zielfenster des single-instance-Plugins fehlte)",
    );
    std::process::exit(0);
}

#[cfg(not(windows))]
fn enforce_single_instance() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_logging();
    // Eine Zeile je Prozessstart: erst daran ist im Protokoll zu erkennen, dass
    // die App zwischendurch neu gestartet wurde – etwa durch ein Update.
    log_line("INFO", &format!("Prozess gestartet (v{})", env!("CARGO_PKG_VERSION")));
    // Direkt danach, aber noch bevor Tauri Fenster baut: so blitzt bei einer
    // zweiten Instanz nichts auf, und ihr Ende steht im Protokoll unter ihrer
    // eigenen Startzeile.
    enforce_single_instance();

    // Tauris Tokio-Laufzeit fuer diesen Thread setzen, bevor irgendein Plugin
    // aufgebaut wird.
    #[cfg(desktop)]
    let rt = tauri::async_runtime::handle();
    #[cfg(desktop)]
    let _rt_guard = rt.inner().enter();

    // Die Konfiguration wird noch angefasst (Update-Kanal), bevor sie unten in
    // .build() geht – ab da liest jedes Plugin seinen Teil daraus.
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(desktop)]
    if beta_updates_enabled() {
        use_beta_channel(&mut context);
    }

    let mut builder = tauri::Builder::default();

    // Desktop-Plugins direkt in der Builder-Kette registrieren (kanonisch),
    // damit ihre Commands garantiert verfügbar sind, bevor ein Fenster lädt.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
                // Ein Deeplink startet unter Windows eine ZWEITE Instanz und
                // uebergibt die Adresse als Argument. Ohne diese Zeile kaeme das
                // Fenster nach vorn, aber der Code bliebe liegen.
                if let Some(url) = args.iter().find(|a| a.starts_with("timetracker://")) {
                    let _ = app.emit("deep-link", url.clone());
                }
                show_main(app);
            }))
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--autostart-hidden"]),
            ))
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_deep_link::init());
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // Der Abgleich spricht ueber diesen Weg mit dem Server. Was erreichbar
        // ist, steht im Scope der capabilities - nicht hier.
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                setup_tray(app)?;

                // Das Hauptfenster steht in tauri.conf.json auf `"visible": false`
                // und wird erst hier gezeigt – beim Autostart (Login) gar nicht,
                // dort bleibt die App im Tray.
                if !std::env::args().any(|a| a == "--autostart-hidden") {
                    show_main(app.handle());
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                // Fenster schliessen = in den Tray legen, App laeuft weiter (Timer/Erinnerungen).
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let _ = window.hide();
                    api.prevent_close();
                }
                // Flyout verschwindet, sobald es den Fokus verliert (wie OneDrive).
                tauri::WindowEvent::Focused(false) if window.label() == "tray" => {
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            set_tray_state,
            show_main_window,
            show_flyout,
            idle_seconds,
            set_tray_tooltip,
            quit_now,
            write_export_file,
            outlook::create_outlook_draft,
            outlook::read_outlook_calendar,
            outlook::read_outlook_mails,
            outlook::detect_outlook,
            secret::protect_secret,
            secret::unprotect_secret
        ])
        .build(context)
        .expect("error while running tauri application")
        .run(|_handle, _event| {});
}

