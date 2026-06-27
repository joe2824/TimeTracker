mod outlook;

use tauri::{Emitter, Manager};

#[derive(serde::Deserialize, Clone)]
pub struct TrayActivity {
    id: String,
    name: String,
    #[serde(default)]
    favorite: bool,
}

#[derive(serde::Deserialize, Default)]
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
        "quit" => app.exit(0),
        _ => {}
    }
}

/// Positioniert das Flyout nahe der Klickposition (über dem Cursor) und zeigt es.
#[cfg(desktop)]
fn toggle_flyout(app: &tauri::AppHandle, click: tauri::PhysicalPosition<f64>) {
    let Some(win) = app.get_webview_window("tray") else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    if let Ok(size) = win.outer_size() {
        let mut x = click.x - size.width as f64 / 2.0;
        let mut y = click.y - size.height as f64 - 8.0; // über dem Cursor (Taskleiste unten)
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
}

#[cfg(desktop)]
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let menu = build_tray_menu(app.handle(), &TrayState::default())?;

    // Links-Klick öffnet das Flyout-Fenster, Rechts-Klick das native Menü (Fallback).
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
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

/// Baut das Tray-Menue neu (laufender Timer + Schnellstart aus Favoriten/zuletzt benutzt).
#[tauri::command]
fn set_tray_state(app: tauri::AppHandle, state: TrayState) -> Result<(), String> {
    #[cfg(desktop)]
    if let Some(tray) = app.tray_by_id("main") {
        let menu = build_tray_menu(&app, &state).map_err(|e| e.to_string())?;
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;

        // Tray-Icon rot, solange ein Timer läuft.
        if state.running.is_some() {
            let red = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-active.png"))
                .map_err(|e| e.to_string())?;
            let _ = tray.set_icon(Some(red));
        } else if let Some(def) = app.default_window_icon() {
            let _ = tray.set_icon(Some(def.clone()));
        }
    }
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

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_autostart::init(
                    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                    Some(vec!["--autostart-hidden"]),
                ))?;
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle()
                    .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
                setup_tray(app)?;

                // Beim Autostart (Login) versteckt im Tray bleiben.
                if std::env::args().any(|a| a == "--autostart-hidden") {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
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
            idle_seconds,
            set_tray_tooltip,
            outlook::create_outlook_draft,
            outlook::read_outlook_calendar
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
