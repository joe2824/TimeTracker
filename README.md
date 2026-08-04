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
- **Zeitwächter-Abgleich** – den Zeitwirtschaftsreport (.xlsx) aus LOGA/Scout per Drag & Drop
  einlesen und sehen, an welchen Tagen Zeit fehlt; fehlende Zeiten lassen sich in einem Rutsch
  einem Projekt zuordnen, siehe [Zeitwächter-Abgleich](#zeitwächter-abgleich).
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
  Tab „Team“: prüft im Outlook-Posteingang, wer seinen Monatsbericht geschickt hat und wer
  nicht, exportiert die Liste als **CSV** und erstellt eine **Erinnerung an die Fehlenden** als
  Outlook-Entwurf. Reiner Lesezugriff – es wird keine Mail verschoben, markiert oder gelöscht.
  Stunden wertet der Chef-Modus bewusst **nicht** aus, siehe [Chef-Modus](#chef-modus).
- **Autostart** mit dem System (versteckt im Tray), **Updater**, Datei-basierte Persistenz.

## Regeln

- Eine **Ganztags-Abwesenheit** und Projektzeit am selben Tag schließen sich aus; ein
  **halber Urlaubstag** darf neben Projektzeit liegen.
- Tage mit Ganztags-Abwesenheit werden im Bericht ohne Projektzeiten gewertet.

## Zeitwächter-Abgleich

In LOGA lässt sich über den Zeitwächter ein **Zeitwirtschaftsreport** („gesetzliche
Arbeitszeitverstöße") erzeugen und in Scout als `.xlsx` herunterladen. Diese Datei wird im Tab
**Einträge** auf die Karte „Zeitwächter-Report" gezogen (oder über einen Klick ausgewählt).

Der Report hat eine Zeile je Kalendertag. Verglichen wird die Spalte **„Arbeitszeit täglich"** –
die ist **netto**, LOGA hat die Pause dort bereits abgezogen (ab 4 h 15 Minuten, ab 6 h weitere
30). Ihr gegenüber steht, was in der App für den Tag erfasst ist. Abweichungen über
**15 Minuten** fallen auf:

| Status | Bedeutung |
|---|---|
| stimmt | Differenz innerhalb der Toleranz |
| fehlt | LOGA kennt Stunden, hier ist nichts erfasst |
| teilweise | hier ist weniger erfasst als LOGA kennt |
| zu viel | hier ist mehr erfasst als LOGA kennt |

Für jeden auffälligen Tag schlägt die App einen Nachtrag vor, der sich einer Aktivität zuordnen
lässt – einzeln oder für alle Tage auf einmal. Zwei Regeln stecken darin:

- **Tage ohne Stempel** mit genau einem halben oder ganzen Tagessatz sind Urlaub, Feiertag oder
  Gleittag – LOGA gibt alle drei identisch aus. Sie werden als **Abwesenheit** vorgeschlagen,
  nicht als Projektzeit.
- **Gestempelte Tage** werden zwischen „Erstes kommen" und „Letztes gehen" aufgefüllt, mit einer
  **Lücke in Höhe der Pause** um die Mittagszeit. Bereits erfasste Zeiten bleiben unberührt, der
  Nachtrag legt sich in die freien Lücken.

Nachgetragene Einträge tragen die Notiz „Zeitwächter" und werden beim nächsten Abgleich als
*bereits nachgetragen* erkannt – ein zweiter Durchlauf erzeugt keine Dubletten. Die Verstoß-Spalten
des Reports (Ruhepause, > 10 h, Sonntags-/Feiertagsarbeit) erscheinen als Badge am jeweiligen Tag.

Der eingelesene Report bleibt unter `data/timereport-YYYY-MM.json` liegen. In der Tagesliste
markiert er Tage, an denen Zeit fehlt, mit einem Fehlbetrag – auch ohne geöffneten Abgleich.

> Die heruntergeladene `.xlsx` enthält Personalnummer und Klarnamen. Sie wird nicht ins Repo
> übernommen (`.gitignore`); für die Tests liegt eine anonymisierte Fassung unter
> `src/lib/testing/`.

## Chef-Modus

Für Vorgesetzte, die die Berichte ihres Teams selbst per Mail bekommen. Einschalten unter
**Einstellungen → Chef-Modus** (Karte weit unten); dort werden auch das Team (Name + E-Mail) und
das Betreff-Merkmal hinterlegt. Der Schalter liegt in `settings.json` und bleibt damit über
Neustarts erhalten.

Im Tab **Team** wird ein Monat gewählt und „Berichte einlesen“ gedrückt. Gesucht wird im
Posteingang (auf Wunsch samt Unterordnern) vom Monatsersten bis zum 20. des Folgemonats nach
Mails mit dem Betreff-Merkmal. Das Ergebnis ist eine Liste: wer hat abgegeben (mit Datum), wer
fehlt. Dazu CSV-Export und eine Sammel-Erinnerung an die Fehlenden.

Zuordnung zur Person: E-Mail-Adresse, sonst Absendername, sonst der Name aus dem Betreff.

### Warum ohne Stunden?

Der Chef-Modus liest **nur den Briefumschlag** – Betreff und Empfangszeit –, nicht den Inhalt
der Mails. Das ist kein Versehen, sondern die Konsequenz aus dem, was Outlook per COM herausgibt.

Die Integration spricht COM, also das **klassische** Outlook (siehe unten) – derselbe Weg wie
beim Erstellen des Berichts-Entwurfs. Entwürfe *schreiben* ist unkritisch; vorhandene Mails
*lesen* schränken Sicherheitsrichtlinien dagegen ein. Ist der programmatische Zugriff gesperrt,
liefert das Objektmodell nur noch die Hülle: Betreff und Empfangszeit kommen an, **Body,
Absendername und -adresse bleiben leer** (`PropertyAccessor` ist dann `null`, `DownloadState`
meldet dauerhaft „nur Kopfzeilen“). Typische Auslöser sind die Gruppenrichtlinien unter
`HKCU\Software\Policies\Microsoft\Office\16.0\Outlook\Security`
(`adminsecuritymode = 3`, `promptoomaddressinformationaccess = 0`).

Daran ändert weder ein laufendes klassisches Outlook noch ein Sync, `Display()`, `GetInspector`
oder `Folder.GetTable()` etwas – das ist durchgemessen. Freigeben kann das nur die IT.

Eine Stundenauswertung wäre unter diesen Bedingungen dauerhaft leer. Statt einer Tabelle voller
Nullen zeigt der Chef-Modus deshalb nur, was wirklich ankommt. Die fertige Auswertung der
Stundentabellen liegt in Commit `90f6aa1`, falls der Zugriff je freigegeben wird.

## Datenablage

JSON im App-Daten-Ordner unter `data/`:

- `data/activities.json` – Aktivitäten (global)
- `data/settings.json` – Einstellungen (global)
- `data/entries-YYYY-MM.json` – eine Datei pro Monat
- `data/timereport-YYYY-MM.json` – eingelesener Zeitwirtschaftsreport, eine Datei pro Monat

Es wird nichts automatisch gelöscht. Unter „Einstellungen → Daten“ lassen sich ganze Jahre
gezielt entfernen (mit Rückfrage) – die Reports des Jahres gehen mit; Monate ohne Einträge
hinterlassen keine Datei.

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
