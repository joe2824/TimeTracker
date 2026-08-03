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
- **Chef-Modus** (optional, in den Einstellungen einschaltbar und dauerhaft gespeichert) –
  Tab „Team“: liest die eingegangenen Monatsberichte des Teams aus dem Outlook-Posteingang,
  fasst sie zu einer Matrix *Person × Aktivität* zusammen, zeigt wer noch fehlt, und erstellt
  daraus einen **Outlook-Entwurf**, einen **CSV-Export** oder eine **Erinnerung an die
  Fehlenden**. Reiner Lesezugriff – es wird keine Mail verschoben, markiert oder gelöscht.
  Siehe [Chef-Modus](#chef-modus).
- **Autostart** mit dem System (versteckt im Tray), **Updater**, Datei-basierte Persistenz.

## Regeln

- Eine **Ganztags-Abwesenheit** und Projektzeit am selben Tag schließen sich aus; ein
  **halber Urlaubstag** darf neben Projektzeit liegen.
- Tage mit Ganztags-Abwesenheit werden im Bericht ohne Projektzeiten gewertet.

## Chef-Modus

Für Vorgesetzte, die die Berichte ihres Teams selbst per Mail bekommen. Einschalten unter
**Einstellungen → Chef-Modus**; dort werden auch das Team (Name + E-Mail), das Betreff-Merkmal
und optional der Empfänger der Zusammenfassung hinterlegt. Der Schalter liegt in
`settings.json` und bleibt damit über Neustarts erhalten.

Im Tab **Team** wird ein Monat gewählt und „Berichte einlesen“ gedrückt. Gesucht wird im
Posteingang (auf Wunsch samt Unterordnern) vom Monatsersten bis zum 20. des Folgemonats nach
Mails mit dem Betreff-Merkmal.

Gelesen werden ausschließlich Berichte, die TimeTracker selbst erzeugt hat – die HTML-Tabelle
aus dem Monatsbericht bzw. deren Textfassung. Fremde Formate werden **nicht geraten**: eine
falsch gelesene Stundenzahl fiele niemandem auf. Solche Mails erscheinen als „Tabelle nicht
lesbar“ und zählen nicht mit.

Zuordnung zur Person: E-Mail-Adresse, sonst Absendername, sonst der Name aus dem Betreff.
Wer im Team steht, aber nichts geschickt hat, erscheint als „kein Bericht“.

### Voraussetzung: Outlook muss Inhalte herausgeben

Die Integration spricht COM, also das **klassische** Outlook (siehe unten) – derselbe Weg wie
beim Erstellen des Berichts-Entwurfs. Entwürfe *schreiben* ist unkritisch; vorhandene Mails
*lesen* kann eine Sicherheitsrichtlinie dagegen einschränken.

Ist der programmatische Zugriff gesperrt, liefert das Objektmodell nur noch die Hülle:
**Betreff und Empfangszeit kommen an, Body, Absendername und -adresse bleiben leer**
(`PropertyAccessor` ist dann `null`, `DownloadState` meldet dauerhaft „nur Kopfzeilen“).
Typische Auslöser sind die Gruppenrichtlinien unter
`HKCU\Software\Policies\Microsoft\Office\16.0\Outlook\Security`
(`adminsecuritymode = 3`, `promptoomaddressinformationaccess = 0`).

Daran ändert weder ein laufendes klassisches Outlook noch ein Sync, `Display()`, `GetInspector`
oder `Folder.GetTable()` etwas – das ist geprüft. Freigeben kann das nur die IT.

Solange der Zugriff gesperrt ist, funktioniert der Chef-Modus **eingeschränkt, aber nützlich**:
Wer abgegeben hat und wer fehlt, ergibt sich aus Betreff und Empfangszeit – inklusive der
Erinnerung an die Fehlenden. Nur die Stundenmatrix bleibt leer; die App sagt das deutlich, statt
Nullen zu zeigen. Die Zuordnung zur Person läuft dann über den Namen im Betreff.

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
    teamReport.ts              Chef-Modus: Mails lesen/aggregieren (getestet)
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
