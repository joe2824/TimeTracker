# TimeTracker

Zeiterfassung für Projektzeiten mit Monatsbericht per E-Mail an die Vorgesetzten. Läuft als
Desktop-Anwendung im Tray oder im Browser. Die Zeiten gleichen sich über alle Geräte ab; was
dabei auf dem Server liegt, ist Ende-zu-Ende verschlüsselt.

| | |
|---|---|
| Desktop | Tauri 2 (Rust, Edition 2021), nur Windows |
| Oberfläche | SvelteKit SPA (adapter-static), Svelte 5 Runes, TypeScript |
| Styling | Tailwind CSS v4, shadcn-svelte |
| Server | SvelteKit (adapter-node), SQLite über better-sqlite3, Drizzle |
| Anmeldung | WebAuthn/Passkey, kein Passwort, keine E-Mail-Pflicht |
| Node | 22 |
| Lizenz | MIT |

**Ausführliche Dokumentation im [Wiki](https://github.com/joe2824/TimeTracker/wiki).**

## Download

Windows-Installer: <https://github.com/joe2824/TimeTracker/releases/latest>

Danach aktualisiert sich die Anwendung selbst — beim Start und stündlich. Von Hand über
Einstellungen → System → „Nach Updates suchen". Kanäle und Manifeste: [Releases](https://github.com/joe2824/TimeTracker/wiki/Releases).

Ohne Installation geht es im Browser gegen einen eigenen Server, siehe [Server](#server).

## Features

- **Timer** — Aktivität wählen, starten, stoppen. „Heute" zeigt alle Zeiten des Tages mit
  Bilanz aus erfasst, Pausenabzug und Arbeitszeit.
- **Aktivitäten** — importieren, umbenennen, sortieren (Drag & Drop), Favoriten, ausblenden,
  archivieren; je Aktivität eine Farbe und ein globales Tastenkürzel.
- **Einträge** — Tagesraster je Monat. Ein Eintrag hat gekoppelte Felder Von/Bis/Stunden, eines
  wird aus den anderen berechnet. Abwesenheiten als Zeitraum (halbe/ganze Tage, Wochenenden
  überspringen), Schnelleingabe, Kalender-Import.
- **Bericht** — Monatsaggregation je Aktivität, Rundung, HTML-Vorschau, „HTML kopieren",
  Outlook-Entwurf.
- **Tray-Menü** — Links-Klick öffnet Schnellstart mit laufendem Timer, Favoriten und zuletzt
  benutzten Timern. Tooltip zeigt die laufende Zeit.
- **Leerlauf-Erkennung** — nach X Minuten ohne Eingabe: Zeit behalten, Leerlauf abziehen oder
  Eintrag verwerfen.
- **Auto-Stop-Warnung**, **Pomodoro/Pausen-Erinnerung**, **globaler Start/Stop-Hotkey**,
  **Autostart** mit dem System.
- **Befehlspalette** (Strg/Cmd+K) — Timer per Fuzzy-Suche starten und stoppen, Tabs wechseln.
- **Auswertung** — Soll/Ist-Saldo, Stunden je Aktivität, Jahres-Heatmap. Lokal, nicht Teil der
  E-Mail, abschaltbar.
- **Automatischer Pausenabzug** — ab 4 h Tagesarbeitszeit 15 Minuten, ab 6 h insgesamt 45.
  Abschaltbar.
- **Arbeitszeit-Check** — schätzt nach ArbZG, ob der 24-Wochen-Schnitt von 8 h zu reißen droht
  und um wie viel man je Arbeitstag herunter müsste. Lokal, abschaltbar.
- **Zeitwächter-Abgleich** — Zeitwirtschaftsreport (.xlsx) aus LOGA/Scout einlesen, fehlende
  Tage finden, Nachträge in einem Rutsch zuordnen.
- **Chef-Modus** (optional) — Tab „Team" prüft im Outlook-Posteingang, wer den Monatsbericht
  geschickt hat. CSV-Export und Sammel-Erinnerung an die Fehlenden. Reiner Lesezugriff: es wird
  keine Mail verschoben, markiert oder gelöscht. Stunden wertet er bewusst nicht aus.
- **Sync** — Ende-zu-Ende verschlüsselt über einen eigenen Server. Passkey zum Anmelden,
  24 Wörter zum Wiederherstellen, Kopplungscode für weitere Geräte.

Ausführlich im Wiki: [Pausenabzug](https://github.com/joe2824/TimeTracker/wiki/Pausen-und-Regeln) ·
[Arbeitszeit-Check](https://github.com/joe2824/TimeTracker/wiki/Arbeitszeit-Check) ·
[Zeitwächter-Abgleich](https://github.com/joe2824/TimeTracker/wiki/Zeitwaechter-Abgleich) ·
[Chef-Modus](https://github.com/joe2824/TimeTracker/wiki/Chef-Modus) ·
[Datenablage](https://github.com/joe2824/TimeTracker/wiki/Datenablage)

## Server

Ein Container, ein Volume. Das Abbild enthält Oberfläche und Server.

```bash
docker pull ghcr.io/joe2824/timetracker-server:latest
```

Für `linux/amd64` und `linux/arm64`. `:latest` bekommen nur stabile Versionen, nie eine Beta.
Wöchentlich neu gebaut, damit Lücken im Grundabbild geflickt ankommen.

Pflicht-Umgebungsvariablen:

| Variable | Bedeutung |
|---|---|
| `ORIGIN` | Adresse im Browser, z. B. `https://tracker.example.de`. Muss exakt stimmen, WebAuthn prüft sie. |
| `RP_ID` | Hostname ohne Schema und Port. Passkeys hängen daran und überleben keinen Wechsel. |
| `INVITE_CODES` | Einladungscodes für den ersten Zugang. Leeren, sobald es einen Verwalter gibt. |

Vorlage: `docker-compose.yml` im Wurzelverzeichnis, `.env` nach `server/.env.example` anlegen.
Alle Variablen, Signaturprüfung und `DEFAULT_SERVER`:
[Server betreiben](https://github.com/joe2824/TimeTracker/wiki/Server-betreiben).

## Entwicklung

Voraussetzungen: Node.js 22, Rust-Toolchain, Tauri-Systemabhängigkeiten
(<https://v2.tauri.app/start/prerequisites/>).

```bash
npm install            # Abhängigkeiten + svelte-kit sync (prepare)

npm run tauri dev      # Desktop-Anwendung im Entwicklungsmodus
npm run tauri build    # Release-Build inkl. Installer

npm run dev            # nur Oberfläche (Vite) im Browser
npm run dev:web        # dasselbe als PWA-Ziel (BUILD_TARGET=web)
npm run check          # svelte-check (Typen/Templates)
npm test               # Vitest

npm run server:dev     # Sync-Server
npm run server:build   # muss VOR server:test laufen
npm run server:test    # Durchstich spricht den gebauten Server über HTTP an
```

Autostart und Tray-Verhalten funktionieren nur im installierten Release-Build, nicht im
Dev-Binary.

## Projektstruktur

```
src/
  routes/+page.svelte          App-Shell, Tabs, Watcher/Hotkeys
  lib/
    app.svelte.ts              zentraler Zustand (Svelte 5 Runes)
    store.ts                   Datei-Persistenz (tauri-plugin-fs)
    time.ts / report.ts        reine Logik (getestet)
    breaks.ts                  automatischer Pausenabzug (getestet)
    arbzg.ts                   Arbeitszeit-Check, 24-Wochen-Prognose (getestet)
    teamReport.ts              Chef-Modus: Abgabe-Kontrolle (getestet)
    xlsx.ts                    XLSX-Leser (ZIP + XML, ohne Paket; getestet)
    timeReport.ts              LOGA-Zeitwirtschaftsreport auswerten (getestet)
    timeReconcile.ts           Abgleich LOGA ↔ Einträge, Nachtrag planen (getestet)
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
