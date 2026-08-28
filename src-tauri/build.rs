fn main() {
    aptabase_key();
    tauri_build::build()
}

/// Reicht den Aptabase-App-Key als Uebersetzungs-Umgebung an `option_env!` weiter.
///
/// Zwei Quellen, in dieser Reihenfolge:
///  1. die Umgebungsvariable `APTABASE_KEY` (so setzt ihn der Release-Workflow
///     aus der GitHub-Variablen),
///  2. eine Zeile `APTABASE_KEY=...` in `src-tauri/.env` (fuer Laeufe von Hand).
fn aptabase_key() {
    // Ohne diese Zeile merkte Cargo eine Aenderung am Key nicht und baute den
    // alten Wert erneut ein.
    println!("cargo:rerun-if-env-changed=APTABASE_KEY");
    println!("cargo:rerun-if-changed=.env");

    if std::env::var("APTABASE_KEY").is_ok_and(|v| !v.is_empty()) {
        return; // Umgebung gewinnt, nichts zu tun.
    }

    let Ok(env_file) = std::fs::read_to_string(".env") else {
        return;
    };
    for line in env_file.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if name.trim() != "APTABASE_KEY" {
            continue;
        }
        let value = value.trim().trim_matches(['"', '\'']);
        if !value.is_empty() {
            println!("cargo:rustc-env=APTABASE_KEY={value}");
        }
        return;
    }
}
