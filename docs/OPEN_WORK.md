# Was offen ist

Stand 2026-09-05, Branch `feat/passkey-vault`. Nichts davon ist deployt.

Abgeschlossene Vorhaben stehen nicht mehr hier, sondern daneben in `docs/` —
[`sync-preload.md`](sync-preload.md) (Vorladen statt Voll-Download, fertig) und
[`cleanup-2026-09.md`](cleanup-2026-09.md) (Kommentar-Aufräumung und
History-Rewrite). Was von dort dauerhaft gilt, steht in [`../AGENTS.md`](../AGENTS.md).

## Hier weitermachen: der Weg durch die echte PWA, von Hand

Alles andere hängt an Tests und `svelte-check`, und die sind grün. Was fehlt,
ist der Durchlauf durch die laufende Anwendung.

**Vorbereitung:** `REGISTRATION_OPEN=true npm run server:dev`, dann
`http://localhost:5173` — nicht Port 1420, und nach jeder Frontend-Änderung
`npm run pwa:bundle` plus Neustart (siehe AGENTS.md, „Befehle").

### Geprüft und in Ordnung

- Konto anlegen ohne Einladungscode, Abgleich läuft.
- Lokale Ablage: `activities.json`, `settings.json`, `entries-*.json` liegen als
  JWE-Compact-Strings in IndexedDB, `device.json`/`outbox.json` als Klartext —
  und in `device.json` steht kein `vaultKey` mehr.
- `timetracker-keys/keys/vault` trägt `{enc, mac}`, beide `extractable: false`.
- Abmelden räumt auf (drei Tests in `browserKeyWiring.test.ts` belegen es; die
  DevTools-Ansicht zeigt danach nur ihren veralteten Stand).

### Noch nicht geprüft

- **Neu laden und nachsehen, ob der Abgleich weiterläuft.** Das war der Fehler
  aus `ada4ba1`, und genau dieser Weg lief noch nie von Hand.
- **Kopplung.** Scheiterte zuletzt an einer fehlenden Migration; seit die durch
  ist, nicht noch einmal versucht.
- **Passkey anlegen.** Nach einem Neuladen kommt eine zusätzliche
  Passkey-Bestätigung dazu — der Schlüssel muss erst wieder aufgemacht werden.
- **Passkey ohne Verpackung**, Seite neu geladen, dann „Passkey verbinden": es
  darf **kein** Passkey-Dialog aufgehen, sondern der Satz mit den 24 Wörtern
  stehen.
- **Koppeln aus den Einstellungen heraus:** der Tab darf danach nicht mehr in
  die Zeiterfassung springen.
- Zweites Browserprofil, nur Passkey, keine 24 Wörter.
- Wiederherstellung über die 24 Wörter.

Danach nach `main` und deployen.

## Beim Deployment

- `npm run reset:crypto -- --yes` im Server-Verzeichnis. Leert `records`,
  `key_wraps` und `pairings` — mit dem JWE-Format sind die Altdaten unlesbar.
  Bewusst getrennt und von Hand anzustoßen, **noch nicht gegen die echte
  Server-DB ausgeführt**.
- Der Server wird derzeit von einer Person benutzt, die ihre Daten lokal hat und
  sich neu verknüpfen kann. Auf alte Serverdaten muss nichts Rücksicht nehmen.

## Beobachten, nicht jagen

`npm audit` meldet eine Sache im Produktivbaum: `cookie <0.7.0`
(GHSA-pxg6-pf52-xh8x, low) über `@sveltejs/kit`. Die neueste Kit-Fassung hängt
weiterhin daran, ein Update gibt es also nicht. Ausnutzbar ist es hier nicht:
die Anwendung setzt genau ein Cookie mit festem Namen und selbst erzeugtem Wert,
nichts davon kommt aus einer Anfrage.

## Aus dem History-Rewrite offen

Die alten Commits sind bei GitHub weiterhin unter ihrer SHA-URL abrufbar, bis
der Support sie löscht — dafür braucht es ein Ticket. Das Backup der alten
History liegt als `~/TimeTracker-PRE-REWRITE-backup.bundle`; erst löschen, wenn
das erledigt ist. Details in [`cleanup-2026-09.md`](cleanup-2026-09.md).

## Kleinkram

`listEntryYears` (`src/lib/store.ts`) liest auf dem Rechner weiterhin jede
Monatsdatei nur zum Zählen. Im Browser läuft es nicht mehr (hängt an
`isTauri()`), und auf dem Rechner steht die exakte Zahl nirgends sonst — der
Aufruf fällt nur bei offenem Systemtab an. Bewusst so gelassen.
