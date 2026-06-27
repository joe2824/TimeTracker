# TimeTracker — Tauri v2 Desktop-App zur Stundenerfassung

## Context

Jeden Monat muss der Nutzer (Automation Engineering, Fresenius Kabi) seine Arbeitszeit
projektweise in eine Liste eintragen und das Ergebnis als Tabelle (siehe Screenshot) per
Outlook an den Chef schicken. Das ist manuell, fehleranfällig und nervig.

Ziel: eine kleine Desktop-App, die
1. **schnelles Erfassen** erlaubt — Aktivität anklicken = Timer läuft (eine aktive Aktivität
   zur Zeit), Wechseln/Stoppen per Klick, auch aus dem Tray;
2. **erinnert** (konfigurierbar, Default 14:00) mit Benachrichtigung „Woran hast du gearbeitet?“;
3. monatlich einen **Bericht im Format des Screenshots** erzeugt (Aktivität | Stunden, graue
   Zeilen, `Others`, `Abwesenheiten`, Summe), auf **halbe Stunden gerundet**;
4. den Bericht **per Knopfdruck als Outlook-Entwurf** öffnet (Empfänger/Betreff/HTML-Tabelle
   vorausgefüllt — der Nutzer klickt nur noch Senden);
5. die **Aktivitätsliste per Copy & Paste oder Datei-Import** befüllt (jede Zeile = eine Aktivität);
6. **Outlook-Kalender/Urlaub** lesen kann, um Termine als Zeit-Vorschläge zu importieren und
   die Zeile `Abwesenheiten` automatisch zu füllen.

Entschiede (mit dem Nutzer geklärt):
- Erfassung: **Timer + Erinnerung**
- Bericht: **HTML-Tabelle im Mail-Text** (kein Anhang)
- Frontend: **Svelte 5 + TypeScript + TailwindCSS + shadcn-svelte**
- Outlook: **COM verfügbar** (klassisch registriert) → COM als Primärweg, `mailto`/`.eml` Fallback
- Greenfield: leeres Verzeichnis, kein Git. Node 24, Rust 1.93/Cargo vorhanden, Tauri-CLI kommt als Dev-Dependency.

## Architektur (Überblick)

- **Tauri v2** (Rust-Backend, schlank gehalten).
- **Frontend Svelte 5 + TS + Vite + Tailwind + shadcn-svelte** — hier liegt die meiste Logik
  (Timer, Reminder, Report-Aggregation, DB-Zugriffe), weil der Nutzer Svelte wartet.
- **Persistenz: JSON-Dateien via `@tauri-apps/plugin-store`** (offizielles Plugin, schreibt JSON
  in den App-Daten-Ordner, atomar). Kein SQL/Migrations nötig. **Pro Monat eine eigene Datei**
  (`entries-YYYY-MM.json`); globale Dateien für Aktivitäten und Einstellungen. Monatsdateien, die
  **älter als 12 Monate** sind, werden beim Start automatisch gelöscht. Dateien sind vom Nutzer
  einseh-/sicherbar.
- **Reminder + Timer-Tick im Frontend** (Svelte-Stores + `setInterval`) + `@tauri-apps/plugin-notification`.
  App läuft **mit Tray und „close-to-tray“**, damit Webview/Logik im Hintergrund weiterläuft.
- **Rust-Commands** nur für das, was Frontend nicht kann: Outlook-Entwurf, Outlook-Kalender lesen,
  Tray-Menü. Beide Outlook-Funktionen rufen ein **gebündeltes PowerShell-Skript (COM)** auf.
- Plugins: `tauri-plugin-store` (JSON-Persistenz), `tauri-plugin-notification`, `tauri-plugin-autostart` (Start bei
  Login, optional in Settings), `tauri-plugin-single-instance`, `tauri-plugin-updater` (GitHub-Releases,
  für späteres Verteilen an Kollegen), `tauri-plugin-dialog` (Datei-Import).

## Projektstruktur

```
TimeTracker/
  package.json, vite.config.ts, svelte.config.js, tailwind.config / app.css, components.json
  src/                              # Svelte-Frontend
    App.svelte                      # Tab-Layout: Tracking | Einträge | Bericht | Aktivitäten | Einstellungen
    lib/
      store.ts                      # JSON-Dateien laden/speichern (plugin-store), Monatsdatei-Routing, Auto-Cleanup
      stores/timer.ts               # aktive Aktivität, laufender Eintrag, Tick
      stores/settings.ts            # Reminder-Zeiten, Chef-Email, Absender, Rundung
      report.ts                     # Monats-Aggregation, 0.5h-Rundung, HTML-Tabelle bauen
      outlook.ts                    # invoke-Wrapper: create_outlook_draft, read_outlook_calendar
      reminders.ts                  # Scheduler (nächste Reminder-Zeit -> Notification)
      import.ts                     # Paste/Datei -> Aktivitäten (split auf \n, trim, dedupe)
      components/                   # Tracking-Panel, ReportPreview, ActivityList, Settings
      components/ui/                # shadcn-svelte Komponenten
  src-tauri/
    src/
      lib.rs                        # Builder: Plugins, Tray, Commands registrieren
      outlook.rs                    # create_outlook_draft / read_outlook_calendar -> PowerShell
      tray.rs                       # Tray-Icon + Menü (Start/Stop, Aktivität wählen, Öffnen, Beenden)
    resources/outlook.ps1           # COM: Mail-Entwurf erstellen + Kalender als JSON lesen
    capabilities/default.json       # Permissions (store, notification, dialog, shell/process, updater)
    tauri.conf.json                 # Fenster, Tray, Bundle, Updater-Endpoint
    Cargo.toml
```

## Datenmodell (JSON-Dateien, `tauri-plugin-store`)

Mehrere Dateien im App-Daten-Ordner:
- `activities.json`: `[{ id, name, sortOrder, archived, isAbsence }]` — importierte Liste;
  `isAbsence` markiert die eingebaute Zeile „Abwesenheiten“ (plus „Others“). Global.
- `settings.json`: `{ reminderTimes: ["14:00"], bossEmail, senderName, rounding: 0.5, autostart,
  calendarKeywordMap }`. Global.
- `entries-YYYY-MM.json`: `[{ id, activityId, startTs, endTs|null, note, source }]` pro **Monat**.
  `endTs=null` = läuft. `source` ∈ timer|manual|calendar. Dauer = end-start.

Regeln:
- Genau **ein** laufender Eintrag; Start einer neuen Aktivität stoppt den vorigen. Persistiert
  über App-Neustart.
- Ein Eintrag wird der Monatsdatei seines `startTs` zugeordnet.
- **Auto-Cleanup beim Start:** `entries-YYYY-MM.json` älter als 12 Monate werden gelöscht
  (`store.ts` listet Monatsdateien, vergleicht mit aktuellem Monat). Per Setting abschaltbar.

## Funktionsweise im Detail

**Tracking-Panel:** Liste der aktiven Aktivitäten als klickbare Buttons; die laufende ist
hervorgehoben mit Live-Zeit. Klick = Wechsel (alter Eintrag bekommt endTs, neuer startet).
Stop-Button beendet. Schnelltabelle der heutigen Einträge.

**Einträge-Tab (EntryEditor):** vollständige Bearbeitungs-Oberfläche für beliebige Tage/Monate.
Monat/Tag wählen → Liste aller Einträge; Eintrag hinzufügen, bearbeiten (Aktivität, Start/Ende
bzw. Dauer, Notiz) und löschen. Vergessene Arbeit nachtragen = manueller Eintrag (`source=manual`).
Schreibt in die jeweilige `entries-YYYY-MM.json`.

**Erinnerungen (`reminders.ts`):** berechnet die nächste konfigurierte Uhrzeit, schläft per
`setTimeout`, sendet dann Notification „Was hast du gearbeitet?“. Klick fokussiert das Fenster
zum Bestätigen/Nachtragen. Läuft solange die App (im Tray) läuft.

**Monatsbericht (`report.ts` + ReportPreview):** Monat wählen → Summe pro Aktivität, auf 0.5h
gerundet. Tabelle enthält **alle** Aktivitäten (auch 0.0-Zeilen) im Screenshot-Layout
(Kopf „Acitivities / Automation Engineering“ | „Stunden“, abwechselnd graue Zeilen, `Others`,
`Abwesenheiten`, Gesamtsumme). Verifikationszeile zeigt Summe inkl. Abwesenheiten zum Abgleich
mit dem Zeitnachweis. Dieselbe HTML-Tabelle dient als Mail-Body.

**Outlook-Entwurf (`outlook.rs` → `outlook.ps1`):** Rust ruft das gebündelte PS-Skript mit
Aktion `draft`, übergibt `to`, `subject`, HTML-Body (über temp-Datei/STDIN, um Quoting zu
vermeiden). Skript: `New-Object -ComObject Outlook.Application`, `CreateItem(0)`, `HTMLBody`,
`To`, `Subject`, dann **`.Display()`** (nicht Send) → Nutzer prüft und sendet. Fehlerfall
(kein COM) → Fallback: `.eml` schreiben und mit Default-Mailclient öffnen, bzw. `mailto`.

**Outlook-Kalender/Urlaub (`outlook.ps1` Aktion `calendar`):** liest den Standard-Kalender im
Datumsbereich, gibt JSON (Betreff, Start, Ende, Ganztägig, Kategorien, BusyStatus) zurück.
Frontend zeigt Termine; Nutzer mappt je Termin auf eine Aktivität (gemerkte keyword→activity-
Map für künftige Auto-Zuordnung) → als `source=calendar`-Einträge übernehmen. Ganztägige
Termine / BusyStatus „Out of Office“ / Kategorie „Urlaub“ → zählen automatisch in
`Abwesenheiten`.

## Umsetzungsschritte

0. **Plan ablegen:** diesen Plan als `PLAN.md` in den Projektordner (OneDrive) schreiben, damit
   er computerübergreifend erhalten bleibt.
1. **Scaffold:** `npm create tauri-app@latest` (Template svelte-ts) im Verzeichnis; Vite/Tauri
   starten. Tailwind + `shadcn-svelte init` einrichten (`components.json`, `app.css`).
2. **Plugins** hinzufügen (Cargo + npm): store, notification, autostart, single-instance,
   updater, dialog. Capabilities in `capabilities/default.json` freigeben.
3. **Store:** `store.ts` mit Laden/Speichern, Monatsdatei-Routing (`entries-YYYY-MM.json`),
   Auto-Cleanup (>12 Monate löschen) beim Start, und Seed der eingebauten Zeilen
   `Others`/`Abwesenheiten` beim ersten Start.
4. **Aktivitäten-Import** (`import.ts` + ActivityList): Textarea-Paste und Datei-Import
   (`plugin-dialog`), je Zeile eine Aktivität, trimmen/dedupen, Reihenfolge per Drag.
5. **Timer** (`stores/timer.ts` + Tracking-Panel + `tray.rs`): Start/Wechsel/Stop, Live-Tick,
   persistente laufende Aktivität, Tray-Schnellwechsel.
5b. **Einträge-Tab** (EntryEditor): Monat/Tag wählen, Einträge hinzufügen/bearbeiten/löschen,
   schreibt in die richtige Monatsdatei.
6. **Reminder** (`reminders.ts` + Settings): konfigurierbare Zeiten, Notification.
7. **Bericht** (`report.ts` + ReportPreview): Aggregation, 0.5h-Rundung, Screenshot-HTML,
   Verifikationssumme.
8. **Outlook** (`outlook.rs` + `outlook.ps1` + `outlook.ts`): Entwurf erstellen; danach
   Kalender-Lesen + Mapping-UI.
9. **Tray + close-to-tray + Autostart-Toggle**; **Updater** auf GitHub-Releases konfigurieren
   (für späteres Verteilen).
10. **Settings-Tab:** Chef-Email, Absendername, Reminder-Zeiten, Autostart, Rundung.

## Verifikation (End-to-End)

- `npm run tauri dev` startet die App; Aktivitätsliste per Paste importieren → Zeilen erscheinen.
- Timer starten/wechseln/stoppen; App schließen (Tray) und neu öffnen → laufender Eintrag bleibt.
- Einträge-Tab: für einen Tag Eintrag anlegen/bearbeiten/löschen → korrekt in `entries-YYYY-MM.json`;
  Eintrag mit Datum eines anderen Monats landet in der passenden Monatsdatei.
- Cleanup: eine `entries-`-Datei älter als 12 Monate anlegen, App starten → Datei wird gelöscht.
- Reminder-Zeit auf die nächste Minute setzen → Notification erscheint.
- Einträge für den aktuellen Monat anlegen → Bericht zeigt Tabelle im Screenshot-Format,
  Summen auf 0.5h gerundet, Abwesenheiten-Zeile korrekt.
- „Outlook-Entwurf erstellen“ → klassisches Outlook öffnet einen Entwurf mit Empfänger,
  Betreff und eingebetteter Tabelle; ohne COM greift `.eml`/`mailto`-Fallback.
- „Aus Outlook-Kalender importieren“ für den Monat → Termine erscheinen, Mapping auf Aktivität
  möglich, ganztägige/OOF-Termine landen in Abwesenheiten.
- `npm run tauri build` erzeugt ein installierbares Bundle (MSI/NSIS) mit Updater-Artefakten.

## Offene Punkte / Hinweise

- COM spricht das **klassische** Outlook-Profil an. Falls der Nutzer überwiegend das *neue*
  Outlook nutzt, muss ein klassisches Profil eingerichtet sein; sonst greift der Fallback. Für
  eine reine New-Outlook/Graph-Lösung wäre eine Azure-App-Registrierung nötig (späterer Ausbau).
- Updater braucht ein Signing-Keypair + GitHub-Release-Endpoint; beim ersten Build einmalig
  erzeugen.

## Umsetzungsstand & wichtige Hinweise (Stand 2026-06-26)

Die App ist implementiert und startet (`npm run tauri dev` kompiliert Backend + Frontend, Fenster
öffnet, alle Plugins/Capabilities werden ohne Fehler initialisiert). Typecheck (`npm run check`)
und Frontend-Build (`npm run build`) laufen sauber.

**Tech-Entscheidungen, die so umgesetzt sind:**
- Persistenz über **`tauri-plugin-fs`** (nicht plugin-store): JSON-Dateien in `AppData/<id>/data/`
  — `activities.json`, `settings.json`, `entries-YYYY-MM.json`. Auto-Cleanup >12 Monate beim Start.
- Frontend-Zustand als **Svelte-5-Runes-Klasse** in `src/lib/app.svelte.ts` (Singleton `app`).
  Reine Logik in `src/lib/time.ts` (Rundung/Formate) und `src/lib/report.ts` (Aggregation + HTML).
- UI: shadcn-svelte (Tailwind v4, base color neutral). Native `<select>` statt shadcn-Select
  (bewusst, weniger Boilerplate). Tabs: Tracking | Einträge | Bericht | Aktivitäten | Einstellungen.
- Tray mit „close-to-tray“ (Fenster schließen = verstecken, App läuft weiter), Tray-Menü
  Öffnen/Timer stoppen/Beenden. Erinnerungen laufen als Frontend-Scheduler + Notification-Plugin.

**Gotchas / Setup-Schritte vor Release:**
- **Updater paniert ohne Config:** `src-tauri/tauri.conf.json` enthält jetzt einen
  `plugins.updater`-Block mit **Platzhaltern** (`endpoints` → `github.com/DEIN-USER/...`,
  `pubkey` leer). Vor dem ersten echten Release: `npm run tauri signer generate` ausführen,
  echten Public Key + Release-Endpoint eintragen und `bundle.createUpdaterArtifacts: true` setzen.
  Sonst ist „Nach Updates suchen“ funktionslos (Fehler wird abgefangen).
- **Outlook = klassisches Outlook via COM.** Integration (Entwurf + Kalender) läuft über das
  eingebettete PowerShell-Skript `src-tauri/resources/outlook.ps1` (`include_str!` in
  `outlook.rs`). COM spricht das **klassische** Outlook-Profil an. Auf dem System sind beide
  Outlooks installiert; nutzt der Anwender fast nur das neue Outlook, muss trotzdem ein klassisches
  Profil existieren, sonst greift nur der Fallback (mailto / „HTML kopieren“). Reine
  New-Outlook-Lösung bräuchte Microsoft Graph + Azure-App-Registrierung.
- `tsconfig.json` darf **kein** `baseUrl`/`paths` enthalten (kollidiert mit SvelteKit-Aliassen);
  `$lib` kommt aus dem generierten SvelteKit-tsconfig.
- `src/lib/utils.ts` muss neben `cn` auch die Typ-Helfer `WithElementRef`, `WithoutChild`,
  `WithoutChildren`, `WithoutChildrenOrChild` exportieren (von shadcn-Komponenten erwartet).

**Tests:** Unit-Tests mit Vitest unter `src/lib/*.test.ts` (Logik der Rundung und der
Berichts-Aggregation). Ausführen mit `npm test`.

## Erweiterungen (zweite Runde)

- **Abwesenheit/Urlaub als Tage:** Abwesenheits-Einträge haben `dayFraction` (1 = ganzer Tag,
  0.5 = halber Tag). Stunden = `dayFraction * settings.hoursPerDay` (Default **7,5 h**, in den
  Einstellungen editierbar). Abwesenheiten werden im Bericht **nicht** gerundet. Timer-Buttons
  zeigen keine Abwesenheiten (`app.trackableActivities`); Abwesenheit wird im Einträge-Tab erfasst.
- **Einträge-Tab = ganzer Monat:** Liste aller Tage des gewählten Monats, **Wochenenden
  schattiert** (`bg-muted/60`), pro Tag Inline-Einträge + Schnell-„+“. Plus **Schnelleingabe**
  (`BulkEntryDialog`): „Mehrere Tage“ (Datumsbereich, nur Werktage optional, Uhrzeiten bzw.
  Tagesanteil bei Urlaub) und „Pauschal“ (z.B. 80 h auf einen Tag für ein Projekt).
- **Tray-Schnellstart:** dynamisches Tray-Menü mit Submenü „Timer starten“ (die 3 zuletzt
  genutzten Aktivitäten via `recentActivities`) + „Mehr… (App öffnen)“, „Timer stoppen“, „Öffnen“,
  „Beenden“. Rust-Command `set_tray_activities` baut das Menü neu auf; das Frontend hält es per
  `$effect` aktuell. Events: `tray-start-activity` / `tray-stop-timer`.
- **Autostart bei Login standardmäßig an** (`defaultSettings.autostart = true`): beim Start wird
  Autostart aktiviert; Login-Start läuft versteckt im Tray (Arg `--autostart-hidden`, in `lib.rs`
  ausgewertet). In den Einstellungen abschaltbar. Hinweis: Im **Dev**-Lauf registriert das den
  Debug-Pfad in `HKCU\...\Run` – bei Bedarf manuell entfernen; im Installer zeigt er auf die
  installierte EXE.
- **Tabs-Fix:** bits-ui setzt `data-state="active"`, shadcn nutzt aber die Variante `data-active:`.
  In `src/app.css` ist daher `@custom-variant data-active (&[data-state="active"])` ergänzt, damit
  der aktive Tab hervorgehoben wird.
