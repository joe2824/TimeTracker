# Was offen ist

Stand 2026-09-24, Branch `dev`, vor dem Release 1.1.0.

Was dauerhaft gilt, steht in [`../AGENTS.md`](../AGENTS.md); abgeschlossene
Vorhaben stehen in der Commit-History, nicht als Datei daneben.

## Nach dem Release 1.1.0 prüfen

- `releases/latest` zeigt auf v1.1.0, das Manifest am Release `beta` ebenfalls.
- Docker-Marken `latest`, `1.1.0`, `1.1` samt cosign-Signatur.
- Update einmal an einer per NSIS installierten Beta und an einer MSI-Installation
  von 1.0.0 durchspielen: der stabile Eintrag `windows-x86_64` in `latest.json`
  zeigt auf das MSI; es darf keine zweite Installation entstehen.
- Toast-Klick bei versteckt gestartetem Autostart: kommt das Fenster nach vorn
  oder blinkt es nur in der Taskleiste?
- Wiki-Seite „Chef-Modus" beschreibt noch die Outlook-Posteingangs-Prüfung.

## Sync: bekannte Schwächen aus der Zeit vor 1.1

Keine Regressionen, aber echte Lücken. Bewusst nicht kurz vor einem stabilen
Release umgebaut, weil jede davon den Kern des Abgleichs anfasst.

- **Tray-Flyout hat einen eigenen Abgleich.** Haupt- und Flyout-Fenster führen je
  eine SyncEngine und eine Outbox im Speicher, schreiben aber dieselbe
  `outbox.json` und dieselben Monatsdateien. Holt sich das Flyout ein echtes
  Timer-Ende zuerst, meldet es die Mitternachts-Rückfrage an seine eigene
  `account`-Instanz - der Dialog hängt nur im Hauptfenster, die Rückfrage fällt
  aus. Richtung: nur das Hauptfenster betreibt die Engine, das Flyout fordert per
  Event an.
- **Mitternachts-Teilung, Gegenrichtung.** Stoppt Gerät A offline um 17:00 und
  teilt Gerät B den Lauf morgens mit altem Stand, verliert A sein echtes Ende
  gegen B's jüngeren Stempel. `#applyEntries` erkennt nur den Fall, in dem das
  lokale Ende genau auf Mitternacht liegt.
- **Veraltete App-Kopie löscht frisch angekommene Einträge.** Spielt eine Runde
  einen Eintrag ein, bevor das Hauptfenster neu geladen hat, und speichert der
  Nutzer genau dann (Timer starten/stoppen), schreibt `#saveMonth` die alte Liste
  zurück - `diffAndStamp` merkt den neuen Eintrag als Löschung vor. Fenster: bis
  zu 5 s während des Nachladens der Historie. Richtung: Löschungen nur für
  Einträge vormerken, die die App tatsächlich kannte.
- **Globale Vormerk-Sperre.** `suppressed` in `outbox.ts` gilt modulweit: eine
  Speicherung aus der Oberfläche, während `#applyInner` läuft, wird ohne Stempel
  geschrieben und erreicht den Server nie. Richtung: der Abgleich schreibt über
  einen eigenen Weg ohne Haken statt über eine globale Sperre.
- **Rückfragen überleben keinen Neustart.** `staleTimerSplits` liegt nur im
  Speicher; nach einem Neustart vor der Entscheidung ist der Fall weg.
- **Bearbeitung über Mitternacht sieht aus wie eine Teilung.** Ein bewusst im
  Editor über Mitternacht gezogener Eintrag hat dieselbe Form wie eine
  Timer-Teilung; die Suche verlangt nicht, dass die Fortsetzung noch offen ist.

## Tests, die fehlen

- `syncNow` mit gleichzeitigen Aufrufern (`#handling`/`#processing`).
- Löschung im Konflikt: die Zweige „Server hat nach der Löschung geändert" und
  `rebaseChanges`.
- Migration einer echten v1.0.0-Datenbank mit Bestandsdaten auf den neuen Stand.
- HTTP-Tests, dass ein Verwalter bei Team löschen, Verwalter-Link, Verwalter
  entfernen und Chef-Rolle übergeben 404 bekommt (heute nur ein Text-Scan in
  `authPolicy.test.ts`).

## Kleinere Punkte

- Verwalter können nicht selbst austreten, nur vom Chef entfernt werden.
- Teams und Mitglieder je Team sind serverseitig nicht begrenzt.
- Icon-Knöpfe in `TeamTab.svelte` und `ActivitiesPanel.svelte` tragen nur `title`,
  kein `aria-label`.
- Der Fallback in `enforce_single_instance` (`lib.rs`, Plugin-Fenster fehlt)
  verliert einen mitgegebenen Deep-Link.
- Das Team-Token liegt in `team.json` im Klartext, anders als das Geräte-Token
  (DPAPI). Es kann nur Berichte hochladen und Aktivitäten lesen.
- Ein eingehender Team-Link fragt die Vorschau beim Server aus dem Link ab, bevor
  jemand bestätigt - der Server erfährt so, dass der Link geöffnet wurde.

## Beobachten, nicht jagen

`npm audit` meldet fünf Einträge im Produktivbaum — alle mit derselben Ursache:
`cookie <0.7.0` (GHSA-pxg6-pf52-xh8x, low) über `@sveltejs/kit`, an dem auch
`bits-ui`, `runed` und `svelte-toolbelt` hängen. Die neueste Kit-Fassung hängt
weiterhin daran; der angebotene „Fix" wäre ein Downgrade auf Kit 0.0.30, also
keiner. Ausnutzbar ist es hier nicht: die Anwendung setzt genau ein Cookie mit
festem Namen und selbst erzeugtem Wert, nichts davon kommt aus einer Anfrage.

## Bewusst so gelassen

`listEntryYears` (`src/lib/store.ts`) liest auf dem Rechner jede Monatsdatei nur
zum Zählen. Im Browser läuft es nicht mehr (hängt an `isTauri()`), auf dem
Rechner steht die exakte Zahl nirgends sonst, und der Aufruf fällt nur bei
offenem Systemtab an.
