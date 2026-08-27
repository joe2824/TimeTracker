# Kommentar- & Text-Aufraeumung — Fortschritt

Laufende Aufgabe: jede Datei einmal durchgehen, Kommentare und Anwender-Texte
pruefen, fixen, committen. Diese Datei ist der Fortschritts-Tracker — sie liegt
im Repo, damit jede Maschine (git pull) genau hier weitermachen kann.

**Nebenbei, unabhaengig von dieser Aufgabe:** In PasskeyPanel.svelte lag zwischendurch
eine uncommittete lokale Aenderung (vermutlich User im Editor). Ein Satz dort
("Erstelle dazu dein Konto im Browser") wirkt falsch, weil die Karte nur sichtbar ist,
wenn das Konto schon verknuepft ist ("Erstelle" statt "Oeffne"). Nicht angefasst,
nur geflaggt.

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
- [x] BackdateDialog.svelte (bereits sauber, keine Aenderung noetig)
- [x] BulkEntryDialog.svelte (bereits sauber, keine Aenderung noetig)
- [x] CalendarImport.svelte
- [x] CommandPalette.svelte (bereits sauber, keine Aenderung noetig)
- [x] DateInput.svelte (bereits sauber, keine Aenderung noetig)
- [x] DayFractionSwitch.svelte
- [x] EntryEditor.svelte (dicht kommentiert, aber gerechtfertigt - keine Aenderung)
- [x] IdleDialog.svelte (bereits sauber, keine Aenderung noetig)
- [x] LogPanel.svelte
- [x] LongTimerDialog.svelte (bereits sauber, keine Aenderung noetig)
- [x] MonthSelector.svelte
- [x] OnboardingWizard.svelte
- [x] PairingCode.svelte
- [x] PasskeyNudge.svelte
- [x] PasskeyPanel.svelte (Original-Beispiel: Server-Adresse-Jargon rausgenommen)
- [x] ProjectSplit.svelte (bereits sauber, keine Aenderung noetig)
- [x] ReportReminderDialog.svelte (bereits sauber, keine Aenderung noetig)
- [x] ReportView.svelte (bereits sauber, keine Aenderung noetig)
- [x] SavedHint.svelte (bereits sauber, keine Aenderung noetig)
- [x] SettingRow.svelte
- [x] SettingToggle.svelte (bereits sauber, keine Aenderung noetig)
- [x] ShortcutKey.svelte
- [x] StatsCard.svelte
- [x] SyncHint.svelte (doppelten Leftover-Kommentar entfernt)
- [x] TeamPanel.svelte
- [x] TimeReportImport.svelte
- [x] TrackingPanel.svelte
- [x] UpdateDialog.svelte (bereits sauber, keine Aenderung noetig)
- [x] VacationRange.svelte (bereits sauber, keine Aenderung noetig)
- [x] WebOnboarding.svelte (2x Bug-Historie entfernt, Rest gerechtfertigt komplex)
- [x] WorkdayPicker.svelte (bereits sauber, keine Aenderung noetig)

## Routen (`src/routes`)

- [x] +layout.svelte (bereits sauber, keine Aenderung noetig)
- [x] +layout.ts (bereits sauber, keine Aenderung noetig)
- [x] +page.svelte (Bug-Historie entfernt, Rest gerechtfertigt komplex)
- [x] tray/+page.svelte

## Lib — Logik (`src/lib/*.ts`, keine Tests)

- [x] analytics.ts (bereits sauber, keine Aenderung noetig)
- [x] app.svelte.ts (Bug-Historie/redundante Kommentare entfernt, Rest gerechtfertigt komplex)
- [x] arbzg.ts (dicht aber exemplarisch begruendet, keine Aenderung)
- [x] backdate.ts (bereits sauber, keine Aenderung noetig)
- [x] breaks.ts (bereits sauber, keine Aenderung noetig)
- [x] calendarMap.ts (bereits sauber, keine Aenderung noetig)
- [x] conflicts.ts (bereits sauber, keine Aenderung noetig)
- [x] defaults.ts (bereits sauber, keine Aenderung noetig)
- [x] entriesFocus.svelte.ts (bereits sauber, keine Aenderung noetig)
- [x] invite.ts (bereits sauber, keine Aenderung noetig)
- [x] log.ts (bereits sauber, keine Aenderung noetig)
- [x] longTimer.ts (bereits sauber, keine Aenderung noetig)
- [x] onboarding.svelte.ts (bereits sauber, keine Aenderung noetig)
- [x] outlook.ts (bereits sauber, keine Aenderung noetig)
- [x] reminders.ts (bereits sauber, keine Aenderung noetig)
- [x] report.ts (Tippfehler "Acitivities" -> "Activities" im HTML-Tabellenkopf gefixt, Rest sauber)
- [x] reportSend.ts (bereits sauber, keine Aenderung noetig)
- [x] settingsSync.ts (bereits sauber, keine Aenderung noetig)
- [x] shortcuts.ts (bereits sauber, keine Aenderung noetig)
- [x] startTime.ts (bereits sauber, keine Aenderung noetig)
- [x] stats.ts (bereits sauber, keine Aenderung noetig)
- [x] store.ts
- [x] teamReport.ts (bereits sauber, keine Aenderung noetig)
- [x] time.ts (bereits sauber, keine Aenderung noetig)
- [x] timeReconcile.ts (2x Beispiel-lastige Kommentare gekuerzt, Rest gerechtfertigt komplex)
- [x] timeReport.ts (bereits sauber, keine Aenderung noetig)
- [x] types.ts (bereits sauber, keine Aenderung noetig)
- [x] tz.ts (dicht aber DST-Kanten gerechtfertigt, keine Aenderung)
- [x] updater.svelte.ts (Bug-Historie-Rest im Kommentar entfernt, Rest gerechtfertigt)
- [x] utils.ts (bereits sauber, keine Aenderung noetig)
- [x] watchers.svelte.ts (bereits sauber, keine Aenderung noetig)
- [x] xlsx.ts (dicht aber ZIP/XML-Kanten gerechtfertigt, keine Aenderung)

## Lib — Unterordner (`src/lib/**/*.ts`, keine Tests, kein `ui/`)

- [x] crypto/vault.ts (dicht aber Krypto-Parameter gerechtfertigt, keine Aenderung)
- [x] platform/deeplink.ts (bereits sauber, keine Aenderung noetig)
- [x] platform/env.ts (bereits sauber, keine Aenderung noetig)
- [x] platform/fs.ts (bereits sauber, keine Aenderung noetig)
- [x] platform/http.ts (bereits sauber, keine Aenderung noetig)
- [x] platform/notify.ts
- [x] platform/open.ts (bereits sauber, keine Aenderung noetig)
- [x] platform/os.ts (bereits sauber, keine Aenderung noetig)
- [x] platform/secrets.ts (bereits sauber, keine Aenderung noetig)
- [x] platform/windows.ts (bereits sauber, keine Aenderung noetig)
- [x] sync/account.svelte.ts (verwaisten Kommentar + Bug-Historie-Satz gefixt, Rest gerechtfertigt komplex)
- [x] sync/api.ts (bereits sauber, keine Aenderung noetig)
- [x] sync/detach.ts (bereits sauber, keine Aenderung noetig)
- [x] sync/device.ts (bereits sauber, keine Aenderung noetig)
- [x] sync/engine.ts (dicht aber Sync-Logik gerechtfertigt, keine Aenderung)
- [x] sync/enroll.ts (bereits sauber, keine Aenderung noetig)
- [x] sync/merge.ts (bereits sauber, keine Aenderung noetig)
- [x] sync/outbox.ts (bereits sauber, keine Aenderung noetig)
- [x] sync/stamp.ts (bereits sauber, keine Aenderung noetig)
- [x] testing/fakeFs.ts (bereits sauber, keine Aenderung noetig)
- [x] testing/pinZone.ts (bereits sauber, keine Aenderung noetig)
- [x] testing/zip.ts (bereits sauber, keine Aenderung noetig)

## Server (`server/src`, keine Tests)

- [x] app.d.ts (bereits sauber, keine Aenderung noetig)
- [x] hooks.server.ts (bereits sauber, keine Aenderung noetig)
- [x] lib/server/account.ts (bereits sauber, keine Aenderung noetig)
- [x] lib/server/auth.ts (bereits sauber, keine Aenderung noetig)
- [x] lib/server/config.ts (bereits sauber, keine Aenderung noetig)
- [x] lib/server/db/index.ts (bereits sauber, keine Aenderung noetig)
- [x] lib/server/db/schema.ts (bereits sauber, keine Aenderung noetig)
- [x] lib/server/events.ts (bereits sauber, keine Aenderung noetig)
- [x] lib/server/invites.ts (bereits sauber, keine Aenderung noetig)
- [x] lib/server/limit.ts (bereits sauber, keine Aenderung noetig)
- [x] lib/server/pairing.ts (bereits sauber, keine Aenderung noetig)
- [x] lib/server/session.ts (bereits sauber, keine Aenderung noetig)
- [x] lib/server/sync.ts (bereits sauber, keine Aenderung noetig)
- [x] lib/server/webauthn.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/[...pfad]/+server.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/api/admin/invites/+server.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/api/auth/device/+server.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/api/auth/login/finish/+server.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/api/auth/login/start/+server.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/api/auth/logout/+server.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/api/auth/recover/+server.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/api/auth/register/finish/+server.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/api/auth/register/start/+server.ts (Bad-Beispiel-Kommentar aus der Doku hier endlich gekuerzt)
- [x] routes/api/devices/+server.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/api/health/+server.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/api/me/+server.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/api/me/confirm/+server.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/api/pair/approve/+server.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/api/pair/claim/+server.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/api/pair/start/+server.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/api/passkeys/+server.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/api/passkeys/finish/+server.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/api/passkeys/start/+server.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/api/sync/+server.ts (bereits sauber, keine Aenderung noetig)
- [x] routes/api/sync/stream/+server.ts (bereits sauber, keine Aenderung noetig)
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
