# Sync: Vorladen statt Voll-Download — Plan

Status: **grösstenteils umgesetzt** (Stand 2026-09-01), siehe "Was steht" unten.
Diese Datei liegt im Repo, damit die Arbeit auf einer anderen Maschine
(git pull) genau hier weitergehen kann.

Ziel: Nach Login/Pairing sind aktueller Monat, Vormonat, Aktivitaeten und
Einstellungen sofort da. Alles Aeltere kommt im Hintergrund nach oder wird
erst geholt, wenn jemand hinsieht. Wichtig vor allem bei schlechter Verbindung.

## Was steht

Umgesetzt in `cc02f7b`, `ec89991`, `dcab713`:

- Schritt 1 (Server-Filter), inkl. `GET /api/sync/buckets` und Index-Migration
- Schritte 2–4 (zweiter Cursor, gestufte Runde, Monatswechsel)
- Schritt 5 (`ensureMonthSynced`, angeschlossen ueber `app.setMonthFetcher`)
- Schritt 6 (Prio beim Verknuepfen)
- Schritt 8 (`reload` liest nicht mehr alles; Sicherung waehrend des Backfills
  abgelehnt)
- Schritt 9 (Hinweisband)
- Schritt 10 (Tests: Server 181, Client 806)
- Schritt 11 (`src/lib/prefetch.ts`, Monatsauswahl und Einstellungs-Tab)

Zwei Dinge kamen unterwegs dazu, weil sie sonst gebrochen waeren:

- `#apply` laeuft durch eine Kette. Zwei gleichzeitige Abrufe wuerden sonst
  dieselbe Monatsdatei lesen, aendern und zurueckschreiben.
- `sync()` gab bei laufendem Durchgang sofort `null` zurueck. `#persistLink`
  feuert `void abgleichMitNachlese()`, ein danebenstehendes `await syncNow()`
  war damit sofort fertig, ohne dass abgeglichen war. Jetzt haengt sich der
  zweite Aufruf an den laufenden. Ein Test prueft nicht mehr auf `null`.

Aus `use:onIntent` wurde `{...onIntent(...)}`: Svelte-Actions duerfen nur an
Elemente, die Ziele hier sind aber alle Komponenten (Button, Select.Item,
Tabs.Trigger).

## Was noch offen ist

- **Schritt 7, Client-Teil.** `Api.buckets()` steht, aber `MonthSelector`
  benutzt es noch nicht. Waehrend des Backfills fehlen aeltere Monate im
  Dropdown - die Pfeile gehen weiter, und ueber die laedt der Prefetch auch
  richtig nach. Zu tun: `bucketFor` fuer die letzten ~60 Monate rechnen und
  gegen die Liste vom Server halten.
- **`listEntryYears`** (`src/lib/store.ts`) liest weiterhin jede Monatsdatei
  nur zum Zaehlen. Wird nur im Jahr-loeschen-Dialog gebraucht.
- **Prefetch-Bremse nur halb.** `prefetchMonth` haelt sich bei `offline`
  zurueck; das Backlog-Budget pausiert waehrend eines Prefetch noch nicht.
- **Konfliktweg im Push.** `#pushAll` loest einen Konflikt weiterhin ueber
  `#pullBacklog(..., Infinity)` auf, also ungedeckelt. Auf einem frisch
  verknuepften Geraet kommt das praktisch nicht vor (Ids sind zufaellig, die
  Outbox ist leer). Sauberer waere, den Datensatz aus `conflicts[].current` zu
  nehmen - den schickt der Server ohnehin mit.
- **Deutsche Bestandsnamen** (siehe unten).

## Namenskonvention (gilt fuer alles hier)

Funktionsnamen, Variablen, Felder, Typen, Dateinamen: **immer Englisch**.
Deutsch nur in Kommentaren, UI-Texten und Commit-Messages.

Der Bestand ist gemischt (`#unbekanntBeimServer`, `monatVon`, `beruehrt`,
`#merkeMonat`, `abgleichMitNachlese`, `#warteschleife` in `src/lib/sync/`) —
das ist Altlast, kein Vorbild. Bestehende Namen NICHT nebenbei umbenennen,
das gehoert in einen eigenen Commit (siehe "Offene Nebenpunkte").

## Befund

Die Infrastruktur ist da, der Client nutzt sie nicht:

- `records.bucket` = HMAC(vaultKey, `bucket|YYYY-MM`), `src/lib/crypto/vault.ts:96`.
  Deterministisch — der Client kann den Bucket jedes Monats selbst rechnen.
- Server-Index `records_bucket` existiert, `server/src/lib/server/db/schema.ts:107`.
  Der Kommentar dort sagt woertlich "Gezieltes Nachladen eines Zeitraums beim
  ersten Abgleich".
- `GET /api/sync?bucket=X` existiert, `server/src/routes/api/sync/+server.ts:16`.
- `Api.pull(since, { bucket })` existiert, `src/lib/sync/api.ts:260`.
- **Die Engine uebergibt `bucket` nie.** `#pullAll` zieht stumpf `since=seq`
  aufsteigend, `src/lib/sync/engine.ts:293`.

Folge: seq aufsteigend = aelteste Daten zuerst. Der aktuelle Monat kommt als
LETZTES, nach der gesamten Historie.

Zweiter Befund, Einstellungs-Panel: bits-ui mountet alle `Tabs.Content` sofort
(Kommentar in `src/routes/+page.svelte:573`). Beim App-Start feuern daher ohne
Zutun 4–5 Round-Trips:

- `src/lib/components/SettingsPanel.svelte:26` -> `/me`
- `src/lib/components/panels/AccountPanel.svelte:161` -> `/me` **nochmal**, ohne Cache
- `src/lib/components/panels/PasskeyPanel.svelte:31` -> `/passkeys`
- `src/lib/components/panels/AdminPanel.svelte:86` -> `/invites` + `/backups`

`AccountInfo` enthaelt `passkeys[]` und `devices[]` bereits (`src/lib/sync/api.ts:65`) —
der separate `/passkeys`-Call ist redundant.

## Die Invariante, an der alles haengt

`records` hat `uniqueIndex(userId, id)`: eine Zeile pro Datensatz, `seq` wird
beim Schreiben hochgezaehlt. Keine Historie.

> Ein Cursor kann ZU ALT sein (redundante Lieferung), nie ZU NEU (verpasste
> Aenderung).

Deshalb ist es unbedenklich, Datensaetze ausser der Reihe anzuwenden:
`mergeRecord` entscheidet ueber `updatedAt`/`deviceId` und ist idempotent.
Ohne diesen Satz faellt der ganze Plan auseinander.

## Schritte

### 1. Server: Filter fuer mehrere Buckets und fuer die ohne

Aktivitaeten und Einstellungen haben `bucket: null` (`src/lib/sync/engine.ts:257`).
Ohne sie gibt es keine Namen, keine Rundung, keine Sollstunden — sie muessen in
die erste Anfrage. `eq(bucket, X)` trifft NULL nicht.

`GET /api/sync?since=N&limit=M&bucket=a&bucket=b&unbucketed=1`

```ts
// server/src/lib/server/sync.ts
export function pullRecords(
	db: Db,
	userId: string,
	opts: {
		since?: number;
		limit?: number;
		/** Leer = alle. Sonst nur diese Buckets. */
		buckets?: string[];
		/** Aktivitaeten und Einstellungen (bucket IS NULL) mitnehmen. */
		includeUnbucketed?: boolean;
	} = {}
): PullResult
```

- `where = and(userId, gt(seq, since), or(inArray(bucket, buckets), isNull(bucket)))`
- `ORDER BY seq` bleibt — `nextSeq` und `hasMore` gelten dadurch unveraendert
  fuer die ganze gefilterte Menge.
- Index auf `(userId, bucket, seq)` erweitern, sonst sortiert SQLite die
  Filtertreffer nach.
- Client-seitig wird `Api.pull(since, { bucket })` zu
  `pull(since, { limit, buckets, unbucketed })`. Bisher kein Aufrufer.

### 2. Client: zwei Cursor statt einem

```ts
// src/lib/sync/engine.ts
interface SyncState {
	/** Bis zu welchem Serverstand dieses Geraet alles kennt. */
	seq: number;
	/** Nur solange der Backfill laeuft: der vorgezogene Teil. */
	priority?: {
		/** Gemeinsamer Cursor ueber die Prio-Menge. */
		seq: number;
		/** Welche Monate vorgezogen werden. */
		months: string[];
	};
}
```

Backfill fertig genau dann, wenn `priority` fehlt. Persistiert in `device.json`
(`DeviceInfo`, `src/lib/store.ts:268`).

### 3. Reihenfolge je Durchgang

```
#round():
  1. push                            (unveraendert)
  2. if (priority) #pullPriority()   aktueller Monat + Vormonat + unbucketed
  3. #pullBacklog(budget)            max 5 Seiten (= 1000 Saetze) pro Runde
```

Das Budget ist noetig: ohne Deckel haengt eine Zeiterfassung, die waehrend eines
mehrminuetigen Backfills gestartet wird, hinter `#running` fest. Nach dem Budget
`#again` setzen, damit die naechste Runde zuerst wieder pusht.

Neue Methoden, alle englisch benannt:

| Name | Zweck |
|---|---|
| `#pullPriority()` | Prio-Menge in einer Anfrage, gemeinsamer Cursor |
| `#pullBacklog(budget)` | globaler Backfill, seitenweise gedeckelt |
| `#pullBucket(bucket, since)` | ein einzelner Bucket bis `hasMore === false` |
| `#priorityBuckets()` | Buckets der Prio-Monate rechnen |
| `ensureMonthSynced(month)` | oeffentlich, siehe Schritt 5 |

### 4. Wenn sich die Prio-Menge aendert

Monatswechsel oder ein auf Zuruf geholter Monat: den neuen Bucket **einmalig
ab `since=0` bis `hasMore === false`** ziehen, dann in `priority.months`
aufnehmen. Der gemeinsame `priority.seq` bleibt stehen.

Nach der Invariante ist ein zu alter Cursor nur redundant, nie lueckenhaft —
also kein Reset und kein erneuter Download der anderen Monate beim Rollover.

### 5. Monat auf Zuruf nachladen

`SyncEngine.ensureMonthSynced(month)`:
- nichts tun, wenn der Backfill durch ist oder der Monat schon in der Menge steht
- sonst diesen einen Bucket ab 0 holen und aufnehmen

Anschluss: `app.ensureMonth(month)` (`src/lib/app.svelte.ts:514`) ruft vorher
`account.ensureMonthSynced(month)`. Damit haengen automatisch mit dran:
`src/lib/components/ReportView.svelte:26`,
`src/lib/components/EntryEditor.svelte:293`,
`src/lib/reportSend.ts:15`.

Das ist der eigentliche Gewinn bei schlechter Verbindung: es kommt nur, was
jemand ansieht.

### 6. Prio beim ersten Abgleich setzen

`#persistLink` (`src/lib/sync/account.svelte.ts:714`) setzt heute `seq: 0`.
Zusaetzlich `priority = { seq: 0, months: [currentMonth, previousMonth] }`.

Bestandsgeraete mit `seq > 0` kennen bereits alles, bekommen kein `priority`
und verhalten sich unveraendert. Keine Migration noetig.

### 7. Monatsauswahl waehrend des Backfills

`src/lib/components/shared/MonthSelector.svelte:27` listet nur lokale Dateien.
Waehrend des Backfills fehlen aeltere Monate im Dropdown (die Pfeile gehen
weiter). Abhilfe: `GET /api/sync/buckets` -> `{ buckets: string[] }`, dazu
`Api.buckets()`. Der Client rechnet `bucketFor` fuer die letzten ~60 Monate und
gleicht ab. 60 HMACs kosten nichts, und der Server erfaehrt dabei nichts Neues —
die Hashes kennt er ohnehin.

Ohne diesen Schritt fehlen im Dropdown genau die Monate, ueber die man in
Schritt 11 hovern soll.

### 8. Lokale Seite (kein Netz, gleiches Thema)

- `src/lib/app.svelte.ts:243-246`: `reload()` liest JEDEN Monat von der Platte in
  den Speicher. Kuerzen auf: aktueller Monat, Vormonat, bereits geladene.
- `src/lib/store.ts:372` `listEntryYears()`: liest jede Monatsdatei nur zum
  Zaehlen. Wird ausschliesslich im Jahr-loeschen-Dialog gebraucht — erst beim
  Oeffnen laufen lassen.
- `src/lib/backup.ts:46`: exportiert ueber `listEntryMonths()`. Waehrend des
  Backfills waere ein Backup unvollstaendig. Knopf sperren oder warnen, solange
  `priority` gesetzt ist.

### 9. Anzeige

Die `bulkSync`-Anzeige gibt es schon (`src/lib/sync/account.svelte.ts:104` und
`:220`, Banner in `src/routes/+page.svelte:552`). Text aendern von
"Daten werden vom Server geladen (N Eintraege)" zu einem Hinweis, dass aeltere
Monate im Hintergrund nachkommen. Im MonthSelector einen Spinner fuer den Monat,
dessen Bucket gerade laeuft.

### 10. Tests

`src/lib/sync/engine.test.ts`:
- die Prio-Anfrage setzt die Bucket-Parameter
- der aktuelle Monat liegt vor den alten Datensaetzen
- ein zu alter Cursor liefert doppelt, es entstehen keine doppelten Eintraege
- ein Eintrag wandert waehrend des Backfills ueber eine Monatsgrenze
- Rollover nimmt einen Monat auf, ohne alles neu zu laden

`server/src/lib/server/sync.test.ts`:
- Filter ueber mehrere Buckets, mit und ohne `unbucketed`
- `nextSeq` und `hasMore` ueber die gemischte Menge

### 11. Prefetch bei Absicht (Hover, Fokus, Touch)

Neues Modul `src/lib/prefetch.svelte.ts`:

```ts
/** Holen oder aus dem Puffer geben - mehrfach hovern kostet nichts. */
export function warm<T>(key: string, fn: () => Promise<T>, ttlMs = 30_000): Promise<T>

/** Puffer verwerfen, z.B. nachdem ein Passkey dazukam. */
export function invalidate(key: string): void

/** Svelte-Action: pointerenter + focus + touchstart, entprellt. */
export function onIntent(node: HTMLElement, opts: { run: () => void; delay?: number })
```

`onIntent` deckt Maus, Tastatur (`focus`) und Touch (`touchstart`, dort gibt es
kein Hover) ab. Entprellung ~100 ms, sonst loest eine Maus, die ueber die
Tab-Leiste wischt, sechs Prefetches aus. Das laufende Versprechen bleibt im
Puffer: ein Klick waehrend des Ladens wartet darauf, statt eine zweite Anfrage
zu starten.

Cache-Keys englisch: `"account"`, `"invites"`, `"backups"`, `` `month:${month}` ``.

| Hover-Ziel | warm() |
|---|---|
| Tab "Einstellungen" | `account.accountInfo()` — Konto, Geraete und Passkeys in EINEM Request |
| Tab "Einstellungen", nur Admin | `account.invites()`, `account.backups()` |
| MonthSelector-Pfeile | Nachbarmonat |
| MonthSelector-Dropdown-Option | dieser Monat |
| Tab "Bericht" / "Eintraege" | aktueller Monat (meist schon da, kostet dann nichts) |

```svelte
<Tabs.Trigger value="settings" use:onIntent={{ run: prefetchSettings }}>
```

```ts
function prefetchMonth(month: string) {
	void warm(`month:${month}`, async () => {
		await account.ensureMonthSynced(month);   // Netz: Bucket holen, Datei schreiben
		await app.ensureMonth(month);             // Platte: in entriesByMonth lesen
	});
}
```

Reihenfolge-Falle: `ensureMonth` merkt sich einen Monat auch als `[]`. Umgekehrt
herum bliebe der leere Monat im Speicher kleben.

**Panels entkoppeln:** die drei `$effect(() => { if (linked && !isLoaded) void load() })`
in `AccountPanel`, `PasskeyPanel` und `AdminPanel` raus; stattdessen aus dem
`warm`-Puffer lesen, der nur durch Hover oder tatsaechliches Oeffnen gefuellt
wird. `PasskeyPanel` nimmt seine Liste aus `accountInfo().passkeys` statt aus
einem eigenen Call. Nach Mutationen (`addPasskey`, `revokeDevice`,
`createInvite`, `renamePasskey`, ...) `invalidate("account")` bzw. `"invites"`.

Ergebnis: der Start macht keine Einstellungs-Requests mehr, der Hover fuellt vor,
bevor der Klick ankommt.

**Prefetch-Bremse.** Spekulation darf die Leitung nicht zumachen, die der
Backfill schon belegt:
- kein Prefetch bei `account.phase === "offline"`
- Monats-Prefetch wartet, solange eine Prio-Anfrage laeuft
- das Backfill-Budget pausiert waehrend eines Prefetch — was jemand gleich sehen
  will, schlaegt Historie

## Baureihenfolge

1. Server-Filter (Schritt 1) — ohne den geht nichts
2. Prio-Cursor und Runden (2–4) — behebt "aktueller Monat kommt zuletzt"
3. `ensureMonthSynced` (5) und Prefetch-Modul (11) — behebt die Wartezeit beim
   Monatswechsel
4. Panels entkoppeln und Bucket-Liste (7) — nimmt die Round-Trips aus dem Start

Schritt 8, 9, 10 laufen nebenher mit.

## Risiken

- Waehrend des Backfills werden die Prio-Monate doppelt gezogen (einmal Prio,
  einmal global). Begrenzt, endet mit dem Backfill. Ein Ausschlussfilter am
  Server waere mehr Aufwand, als der Traffic wert ist.
- `bucket` verraet dem Server, in wie vielen Monaten Daten liegen. Gilt heute
  schon, aendert sich nicht.

## Offene Nebenpunkte (eigene Commits)

- Deutsche Bestandsnamen aufraeumen: `#unbekanntBeimServer`, `monatVon`,
  `beruehrt`, `geladen`, `#merkeMonat`, `abgleichMitNachlese`, `#warteschleife`,
  `kontoKennung`, `bestandGehoertZu`. Reines Umbenennen, getrennt vom Umbau —
  sonst verdeckt der Diff die eigentliche Aenderung.
- `src/lib/backup.ts:46` — unvollstaendiges Backup waehrend des Backfills.
- `src/lib/store.ts:372` — `listEntryYears` liest jede Monatsdatei nur zum Zaehlen.
