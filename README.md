# TimeTracker

Desktop-Zeiterfassung für Projektzeiten mit Monatsbericht per E-Mail an den/die Vorgesetzte:n.
Läuft im Hintergrund (Tray), erfasst Zeiten per Timer und erstellt am Monatsende eine fertige
Stundenübersicht.

Gebaut mit **Tauri 2**, **SvelteKit** (SPA, adapter-static), **Svelte 5 Runes**, **TypeScript**
und **Tailwind CSS v4** / shadcn-svelte.

## Download

Neueste Version (Windows-Installer): **<https://github.com/joe2824/TimeTracker/releases/latest>**


Die App aktualisiert sich anschließend selbst (Einstellungen → „Nach Updates suchen").

## Features

- **Timer-Tracking** – Aktivität wählen, Timer starten/stoppen, „Heute"-Übersicht.
- **Aktivitäten** – importieren (Textfeld/Datei), umbenennen, sortieren (Drag & Drop), Favoriten,
  ausblenden, archivieren, eigene **Farbe** und globaler **Tastenkürzel** je Aktivität.
- **Einträge** – Tagesraster pro Monat; Eintrag mit gekoppelten Feldern **Von / Bis / Stunden**
  (eines wird aus den anderen berechnet); **Urlaub/Abwesenheit als Zeitraum** (halbe/ganze Tage,
  Wochenenden überspringen); Schnelleingabe; Kalender-Import.
- **Bericht** – Monatsaggregation je Aktivität, Rundung, HTML-Vorschau, „HTML kopieren" und
  **Outlook-Entwurf** erstellen.
- **Tray-Menü (OneDrive-Stil)** – Links-Klick öffnet Schnellstart: laufender Timer + Stop,
  Favoriten und zuletzt benutzte Timer; Live-Tooltip mit laufender Zeit.
- **Leerlauf-Erkennung** – nach X Minuten ohne Eingabe fragt die App: Zeit behalten, Leerlauf
  abziehen oder Eintrag verwerfen.
- **Auto-Stop-Warnung** und **Pomodoro/Pausen-Erinnerung** (konfigurierbar).
- **Globaler Start/Stop-Hotkey** für den zuletzt benutzten Timer.
- **Befehlspalette** (Cmd/Ctrl+K) – Timer per Fuzzy-Suche starten/stoppen, Tabs wechseln.
- **Auswertung** – Soll/Ist-Saldo, Stunden je Aktivität und Jahres-Heatmap der gearbeiteten
  Tage. Rein lokal, kein Teil der E-Mail; in den Einstellungen abschaltbar.
- **Autostart** mit dem System (versteckt im Tray), **Updater**, Datei-basierte Persistenz.

## Regeln

- Eine **Ganztags-Abwesenheit** und Projektzeit am selben Tag schließen sich aus; ein
  **halber Urlaubstag** darf neben Projektzeit liegen.
- Tage mit Ganztags-Abwesenheit werden im Bericht ohne Projektzeiten gewertet.

## Datenablage

JSON im App-Daten-Ordner unter `data/`:

- `data/activities.json` – Aktivitäten (global)
- `data/settings.json` – Einstellungen (global)
- `data/entries-YYYY-MM.json` – eine Datei pro Monat

Es wird nichts automatisch gelöscht. Unter „Einstellungen → Daten“ lassen sich ganze Jahre
gezielt entfernen (mit Rückfrage); Monate ohne Einträge hinterlassen keine Datei.

## Entwicklung

Voraussetzungen: Node.js, Rust-Toolchain, Tauri-Systemabhängigkeiten
(siehe <https://v2.tauri.app/start/prerequisites/>).

```bash
npm install            # Abhängigkeiten + svelte-kit sync (prepare)
npm run tauri dev      # App im Entwicklungsmodus
npm run tauri build    # Release-Build inkl. Installer

npm run dev            # nur Frontend (Vite) im Browser
npm run check          # svelte-check (Typen/Templates)
npm test               # Vitest (reine Logik: time.ts, report.ts)
```

> Autostart und Tray-Verhalten funktionieren nur im installierten Release-Build, nicht im
> Dev-Binary.

## Projektstruktur

```
src/
  routes/+page.svelte          App-Shell, Tabs, Watcher/Hotkeys
  lib/
    app.svelte.ts              zentraler Zustand (Svelte 5 Runes)
    store.ts                   Datei-Persistenz (tauri-plugin-fs)
    time.ts / report.ts        reine Logik (getestet)
    shortcuts.ts               globale Tastenkürzel
    reminders.ts               Erinnerungen (Notifications)
    watchers.svelte.ts         Leerlauf, Auto-Stop, Pomodoro, Tray-Tooltip
    components/                UI (Tracking, Einträge, Bericht, Aktivitäten, Einstellungen, …)
src-tauri/                     Rust: Tray, Idle-Query, Outlook, Plugins
```

## Empfohlenes IDE-Setup

[VS Code](https://code.visualstudio.com/) +
[Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode) +
[Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) +
[rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer).
