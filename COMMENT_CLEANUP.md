# Kommentar- & Text-Aufraeumung — Fortschritt

Laufende Aufgabe: jede Datei einmal durchgehen, Kommentare und Anwender-Texte
pruefen, fixen, committen. Diese Datei ist der Fortschritts-Tracker — sie liegt
im Repo, damit jede Maschine (git pull) genau hier weitermachen kann.

## Regeln

**Code-Kommentare:**
- Kein Storytelling ("vorher war es X, jetzt Y, weil Z..."). Keine Romane.
- Wenn eine Funktion/Stelle einfach und offensichtlich ist: **kein Kommentar**.
- Wenn sie gross/komplex ist oder einen nicht offensichtlichen Grund hat
  (Bug-Vermeidung, Plattform-Eigenheit, Reihenfolge-Zwang): **ein kurzer Satz**,
  was/warum — keine Vorher-Nachher-Geschichte.
- Beispiel schlecht (real aus dem Code entfernt):
  > // Geschlossener Betrieb: der Code wird hier nur GEPRUEFT, nicht entwertet.
  > // Entwertet wird er erst, wenn das Konto wirklich entsteht - sonst verbraucht
  > // ein abgebrochener Versuch ihn ersatzlos.
- Wenn ein Kommentar nur wiederholt, was direkt darunter im UI-Text (z. B.
  Card.Description) schon steht: Kommentar loeschen, nicht doppelt pflegen.

**Anwender-sichtbare Texte (Labels, Beschreibungen, Fehlermeldungen):**
- Zielgruppe: normale Anwender ohne technisches Vorwissen. Kein Insider-/Dev-Jargon.
- Beispiel schlecht (real):
  > „Passkeys hängen an der Adresse des Servers – die Desktop-Anwendung hat keine.
  > Angelegt wird einer im Browser, sobald du ihn dort gekoppelt hast."
  So redet niemand mit normalen Nutzern. Umschreiben in klares, einfaches Deutsch.
- Business-/Fachbegriffe, die zur Zielgruppe gehoeren (z. B. Arbeitszeitgesetz,
  LOGA-Bezug bei Pausenregeln), sind KEIN Jargon-Problem — die App ist fuer
  deutsche Buero-Anwender mit genau diesem Kontext gebaut. Nur echtes
  Technik-/Architektur-Vokabular raus, das ein Endanwender nicht braucht.

**Ablauf je Datei:**
1. Datei lesen, Kommentare + sichtbare Texte pruefen, fixen.
2. `npx svelte-check` (bei .svelte/.ts) bzw. passenden Rust-Check laufen lassen.
3. Checkbox unten abhaken, git commit (eine Datei = ein Commit, klein halten).
4. Naechste Datei. Bei viel Kontextverbrauch: Konversation clearen, hier weiterlesen.

**Out of scope:** `src/lib/components/ui/**` (shadcn-svelte Bibliothek, nicht
projekteigen — nicht anfassen).

---

## Komponenten (`src/lib/components/*.svelte`)

- [x] SettingsPanel.svelte
- [x] AbsenceOverrideDialog.svelte
- [x] AccountPanel.svelte
- [x] ActivitiesPanel.svelte (bereits sauber, keine Aenderung noetig)
- [x] ActivityCombobox.svelte (bereits sauber, keine Aenderung noetig)
- [x] ActivityDot.svelte
- [x] AdminPanel.svelte
- [x] ArbZgCard.svelte
- [ ] BackdateDialog.svelte
- [ ] BulkEntryDialog.svelte
- [ ] CalendarImport.svelte
- [ ] CommandPalette.svelte
- [ ] DateInput.svelte
- [ ] DayFractionSwitch.svelte
- [ ] EntryEditor.svelte
- [ ] IdleDialog.svelte
- [ ] LogPanel.svelte
- [ ] LongTimerDialog.svelte
- [ ] MonthSelector.svelte
- [ ] OnboardingWizard.svelte
- [ ] PairingCode.svelte
- [ ] PasskeyNudge.svelte
- [ ] PasskeyPanel.svelte
- [ ] ProjectSplit.svelte
- [ ] ReportReminderDialog.svelte
- [ ] ReportView.svelte
- [ ] SavedHint.svelte
- [ ] SettingRow.svelte
- [ ] SettingToggle.svelte
- [ ] ShortcutKey.svelte
- [ ] StatsCard.svelte
- [ ] SyncHint.svelte
- [ ] TeamPanel.svelte
- [ ] TimeReportImport.svelte
- [ ] TrackingPanel.svelte
- [ ] UpdateDialog.svelte
- [ ] VacationRange.svelte
- [ ] WebOnboarding.svelte
- [ ] WorkdayPicker.svelte

## Routen (`src/routes`)

- [ ] +layout.svelte
- [ ] +layout.ts
- [ ] +page.svelte
- [ ] tray/+page.svelte

## Lib — Logik (`src/lib/*.ts`, keine Tests)

- [ ] analytics.ts
- [ ] app.svelte.ts
- [ ] arbzg.ts
- [ ] backdate.ts
- [ ] breaks.ts
- [ ] calendarMap.ts
- [ ] conflicts.ts
- [ ] defaults.ts
- [ ] entriesFocus.svelte.ts
- [ ] invite.ts
- [ ] log.ts
- [ ] longTimer.ts
- [ ] onboarding.svelte.ts
- [ ] outlook.ts
- [ ] reminders.ts
- [ ] report.ts
- [ ] reportSend.ts
- [ ] settingsSync.ts
- [ ] shortcuts.ts
- [ ] startTime.ts
- [ ] stats.ts
- [ ] store.ts
- [ ] teamReport.ts
- [ ] time.ts
- [ ] timeReconcile.ts
- [ ] timeReport.ts
- [ ] types.ts
- [ ] tz.ts
- [ ] updater.svelte.ts
- [ ] utils.ts
- [ ] watchers.svelte.ts
- [ ] xlsx.ts

## Lib — Unterordner (`src/lib/**/*.ts`, keine Tests, kein `ui/`)

- [ ] crypto/vault.ts
- [ ] platform/deeplink.ts
- [ ] platform/env.ts
- [ ] platform/fs.ts
- [ ] platform/http.ts
- [ ] platform/notify.ts
- [ ] platform/open.ts
- [ ] platform/os.ts
- [ ] platform/secrets.ts
- [ ] platform/windows.ts
- [ ] sync/account.svelte.ts
- [ ] sync/api.ts
- [ ] sync/detach.ts
- [ ] sync/device.ts
- [ ] sync/engine.ts
- [ ] sync/enroll.ts
- [ ] sync/merge.ts
- [ ] sync/outbox.ts
- [ ] sync/stamp.ts
- [ ] testing/fakeFs.ts
- [ ] testing/pinZone.ts
- [ ] testing/zip.ts

## Server (`server/src`, keine Tests)

- [ ] app.d.ts
- [ ] hooks.server.ts
- [ ] lib/server/account.ts
- [ ] lib/server/auth.ts
- [ ] lib/server/config.ts
- [ ] lib/server/db/index.ts
- [ ] lib/server/db/schema.ts
- [ ] lib/server/events.ts
- [ ] lib/server/invites.ts
- [ ] lib/server/limit.ts
- [ ] lib/server/pairing.ts
- [ ] lib/server/session.ts
- [ ] lib/server/sync.ts
- [ ] lib/server/webauthn.ts
- [ ] routes/[...pfad]/+server.ts
- [ ] routes/api/admin/invites/+server.ts
- [ ] routes/api/auth/device/+server.ts
- [ ] routes/api/auth/login/finish/+server.ts
- [ ] routes/api/auth/login/start/+server.ts
- [ ] routes/api/auth/logout/+server.ts
- [ ] routes/api/auth/recover/+server.ts
- [ ] routes/api/auth/register/finish/+server.ts
- [ ] routes/api/auth/register/start/+server.ts  ← enthaelt das Beispiel-Kommentar oben, HIER ZUERST
- [ ] routes/api/devices/+server.ts
- [ ] routes/api/health/+server.ts
- [ ] routes/api/me/+server.ts
- [ ] routes/api/me/confirm/+server.ts
- [ ] routes/api/pair/approve/+server.ts
- [ ] routes/api/pair/claim/+server.ts
- [ ] routes/api/pair/start/+server.ts
- [ ] routes/api/passkeys/+server.ts
- [ ] routes/api/passkeys/finish/+server.ts
- [ ] routes/api/passkeys/start/+server.ts
- [ ] routes/api/sync/+server.ts
- [ ] routes/api/sync/stream/+server.ts
- [ ] routes/api/sync/wait/+server.ts
- [ ] routes/api/wraps/+server.ts

## Rust (`src-tauri/src`)

- [ ] lib.rs
- [ ] main.rs
- [ ] outlook.rs
- [ ] secret.rs

## Scripts

- [ ] docker-durchstich.ts
- [ ] recover-probe.ts

## Tests (`*.test.ts`, niedrige Prioritaet — nur Kommentare, keine Anwender-Texte)

- [ ] server/src/lib/server/api.test.ts
- [ ] server/src/lib/server/limit.test.ts
- [ ] server/src/lib/server/origins.test.ts
- [ ] server/src/lib/server/pairing.test.ts
- [ ] server/src/lib/server/sync.test.ts
- [ ] server/src/lib/server/webauthn.test.ts
- [ ] src/lib/analytics.test.ts
- [ ] src/lib/app.svelte.test.ts
- [ ] src/lib/arbzg.test.ts
- [ ] src/lib/backdate.test.ts
- [ ] src/lib/breaks.test.ts
- [ ] src/lib/calendarMap.test.ts
- [ ] src/lib/conflicts.test.ts
- [ ] src/lib/crypto/vault.test.ts
- [ ] src/lib/entriesFocus.dom.test.ts
- [ ] src/lib/entriesFocus.svelte.test.ts
- [ ] src/lib/invite.test.ts
- [ ] src/lib/log.test.ts
- [ ] src/lib/longTimer.test.ts
- [ ] src/lib/outlook.test.ts
- [ ] src/lib/platform/deeplink.test.ts
- [ ] src/lib/platform/fs.test.ts
- [ ] src/lib/platform/http.test.ts
- [ ] src/lib/reminders.test.ts
- [ ] src/lib/report.test.ts
- [ ] src/lib/settingsSync.test.ts
- [ ] src/lib/startTime.test.ts
- [ ] src/lib/stats.test.ts
- [ ] src/lib/store.test.ts
- [ ] src/lib/sync/detach.test.ts
- [ ] src/lib/sync/engine.test.ts
- [ ] src/lib/sync/merge.test.ts
- [ ] src/lib/sync/nachlese.test.ts
- [ ] src/lib/sync/outbox.test.ts
- [ ] src/lib/sync/prf.test.ts
- [ ] src/lib/sync/stamp.test.ts
- [ ] src/lib/teamReport.test.ts
- [ ] src/lib/time.test.ts
- [ ] src/lib/timeReconcile.test.ts
- [ ] src/lib/timeReport.test.ts
- [ ] src/lib/timeReportFlow.test.ts
- [ ] src/lib/tz.test.ts
- [ ] src/lib/xlsx.test.ts

---

Zuletzt aktualisiert: 2026-08-27
