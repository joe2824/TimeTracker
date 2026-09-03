# Was offen ist

Stand 2026-09-03, Branch `feat/passkey-vault`. Nach Prioritaet, nicht nach Thema.
Nichts davon ist deployt - `main` steht bei `0d72a0c`.

Offen: P2 (der Weg durch die echte PWA, von Hand) und das Ausfuehren von
`npm run reset:crypto -- --yes` beim tatsaechlichen Deployment (siehe unten).
Alles andere haengt an Tests und `svelte-check`.

## ~~Code-Review des JWE-Umbaus (8 Finder-Agenten)~~ erledigt

`/code-review` auf den vollen Diff der vier Commits unten losgelassen, alle
Funde am tatsaechlichen Code nachgeprueft (nicht ungeprueft uebernommen),
15 davon ueber `ReportFindings` gemeldet. Fuenf Commits daraus:

- **`df2f03d`** - der schwerwiegendste Fund: ein vor diesem Branch
  verknuepftes Geraet haette beim ersten Laden nach dem Update seine
  gesamten lokalen Daten verloren (`clearAccountData()`, weil der alte
  Schluessel aus `device.json` nie in die neue Ablage uebernommen wurde).
  Dazu ein zusammenhaengender Fund-Cluster: eine Race beim Schluessel-
  Vorladen konnte echte verschluesselte Dateien mit Klartext-Leerzustand
  ueberschreiben oder faelschlich in Quarantaene schicken - der Start wirft
  jetzt sichtbar, statt still weiterzulaufen. Nebenbei: doppelter
  IndexedDB-Abruf beim Start behoben, der blockierende Verschluesselungs-
  Sweep laeuft jetzt erst nach dem Laden.
- **`04acd30`** - die CSP-Kopfzeile des Servers erlaubte trotz des
  Hash-Modus im Meta-Tag weiterhin pauschal `unsafe-inline` fuer
  `script-src`. Uebernimmt den Hash jetzt aus derselben Datei.
- **`4a42058`** - die drei Ver-/Entpackwege in `vault.ts` (Phrase/PRF/
  Geraet) auf einen gemeinsamen Kern zusammengelegt.
- **`7670df1`** - `fs.ts` und `keyStore.ts` teilten sich die
  IndexedDB-Verdrahtung nicht, jetzt ein gemeinsames Modul, dabei eine
  fehlende Absicherung gegen eine blockierte Verbindung nachgezogen.

**Nicht behoben, bewusst so belassen:** zwei der Review-Funde betreffen
bereits bestehende Commit-Nachrichten (`f3d27b5`, `18cc68e` nutzen das
verbotene Wort "Tresorschluessel" laut `AI_GUIDELINES.md`; `70caa24` nutzt
`security(csp):` als Typ, der nicht in der erlaubten Liste steht). Das
Umschreiben bestehender Commit-Nachrichten haette ein `git commit --amend`/
`rebase` gebraucht - macht dieser Branch nicht ohne ausdrueckliche Bitte.

## ~~Krypto-Schicht auf JWE + lokale Verschlüsselung im Browser~~ erledigt

Ausgangspunkt war der unten stehende P1-Punkt (lokale Eintraege im Browser
unverschluesselt). Beim Entwurf des Formats zeigte sich, dass die drei
hand-gebauten Schluessel-Verpackungen (Wiederherstellungsphrase/PBKDF2,
Passkey-PRF/HKDF, Geraete-Kopplung/ECDH) fast 1:1 auf JWE (RFC 7516/7518,
Bibliothek `jose`) abbilden - daraus wurde ein kompletter Umbau der
Krypto-Schicht, nicht nur der neue Teil. Vier Commits, in dieser Reihenfolge:

1. **`f3d27b5`** - `sealRecord`/`openRecord` (Sync-Wireformat) und die drei
   Verpackungswege auf JWE umgestellt (`alg:"dir"`, `PBES2-HS512+A256KW`,
   `A256GCMKW`, `ECDH-ES+A256KW`). `packSealed`/`unpackSealed`,
   `serializeWrap`/`deserializeWrap`, `wrapWith`/`unwrapWith`, `kekFromPhrase`,
   `kekFromEcdh`, `KeyWrap`/`Sealed` ersatzlos weg - der JWE-Compact-String ist
   bereits das fertige Wire-Format. Server unveraendert (prueft `payload`/
   `wrapped_key` nie inhaltlich, nur Laenge).
2. **`18cc68e`** - lokale Ablage im Browser verschluesselt (`activities.json`,
   `settings.json`, `entries-*.json`, `timereport-*.json`; `device.json`/
   `outbox.json` bleiben Klartext). Schluessel-Persistenz: nicht-exportierbarer
   `CryptoKey` in einer eigenen IndexedDB (`platform/keyStore.ts`) statt
   lesbarer Bytes in `device.json` - `exportKey` schlaegt dafuer fuer immer
   fehl, eine Zusage der Web-Crypto-Spezifikation. Migration: alte
   Klartextdateien lesen sich weiter, werden beim naechsten Speichern
   verschluesselt, dazu ein einmaliger Nachhol-Durchlauf beim Start
   (`DeviceInfo.localFilesEncrypted`).
3. **`cbdf872`** - `server/scripts/reset-crypto-data.ts`
   (`npm run reset:crypto -- --yes`, Server-Verzeichnis): leert `records`,
   `key_wraps`, `pairings` - mit dem neuen Format unlesbare Altdaten. **Noch
   nicht gegen die echte Server-DB ausgefuehrt**, das ist ein bewusst
   getrennter, von Hand anzustossender Schritt beim Deployment.
4. **`70caa24`** - `script-src` der CSP ohne pauschales `unsafe-inline`
   (SvelteKits CSP-Hash-Modus, `svelte.config.js`). Die CSP selbst gab es
   schon (`server/src/hooks.server.ts`) - das war eine falsche Annahme
   unterwegs, korrigiert.

Dazu `6f9880b`: `scripts/recover-probe.ts`/`docker-smoke-test.ts` ans neue
Wireformat angepasst (waren sonst kaputt, kein `svelte-check`/`vitest` deckt
`scripts/` ab) und komplett auf englische Bezeichner umbenannt (waren
durchgehend deutsch, kein `svelte-check` haette das gemeldet).

**Akzeptierte Konsequenz:** jede vor `f3d27b5` synchronisierte Zeiterfassung
und jede alte Passkey-/Phrasen-/Kopplungs-Verpackung ist mit dem neuen Format
unlesbar. Keine Migration - lokale Daten auf den Geraeten bleiben erhalten,
betroffene Konten brauchen neue Verpackungen oder ein neues Konto.

**Fuer P2 kommt dazu:** IndexedDB im Browser auf JWE-Strings statt Klartext
pruefen (`Application → IndexedDB → timetracker → dateien` fuer die Dateien,
`timetracker-schluessel` fuer den nicht-exportierbaren Schluessel), und alle
drei Verpackungswege einmal durchspielen (Passkey anlegen, mit Phrase
wiederherstellen, Geraet koppeln) - komplett neue Krypto, nicht nur neu
verpackt.

## ~~P0 — die Kontokennung bei der Kopplung~~ erledigt

`checkPairing` reicht `answer.userId` durch (`b0c268e`), und `#persistLink`
erbt bei einem Wechsel nichts mehr:
`accountUserId: userId ?? (switched || foreignCopy ? undefined : info.accountUserId)`.
Der Fall "Kennung veraltet" steht in `storedKey.test.ts` ("erbt die Kennung
NICHT, wenn ein anderer Schluessel dazukommt").

## ~~P1 — die Sitzung~~ erledigt

`userFromSession` schiebt `expiresAt` jetzt nach, wenn seit dem letzten Setzen
`SESSION_REFRESH_MS` (24 h) vergangen sind - nicht bei jeder Anfrage. Der
Rueckgabewert ist `{userId, slid}`, weil auch das Cookie mitwandern muss.
Wer die Anwendung benutzt, wird nicht mehr abgemeldet.

~~Offen und AELTER als dieser Branch: die lokalen Eintraege liegen im Browser
unverschluesselt (`store.ts:85`, IndexedDB).~~ Erledigt, siehe oben.

## P2 — im Browser durchklicken

Nichts aus diesem Branch ist von Hand geprueft, alles haengt an Tests und
`svelte-check`. Der Weg, der zaehlt:

```
npm run server:dev
npm run dev:web
```

Konto anlegen -> Passkey traegt sofort „entschluesselt" -> zweites
Browserprofil, nur Passkey, keine 24 Woerter -> Desktop koppeln -> abmelden ->
wieder anmelden.

Danach nach `main` und deployen. Der Fix aus `67d55cc` wirkt nur fuer NEUE
Konten; bestehende Passkeys ohne Verpackung repariert die Passkey-Verwaltung
einmalig.

## P3 — Reste

- ~~**`PasskeyNudge` prueft kontoweit.**~~ erledigt. Die Entscheidung liegt jetzt
  in `missingPasskey` (`src/lib/passkeyStatus.ts`) und geht je Passkey: welcher
  an diesem Browser haengt, steht als `passkeyId` in der `device.json` (gesetzt
  bei Anmeldung, Anlegen und Reparatur, faellt beim Kontowechsel weg). Ist er
  unbekannt - Anmeldung ueber die 24 Woerter oder eine Kopplung -, bleibt es
  beim Blick aufs ganze Konto.
- ~~**`credentials.has_prf` weg.**~~ erledigt. Spalte, Schema-Feld, der Parameter
  von `storeCredential` und das Feld im Wire-Format von `/api/passkeys/finish`
  sind raus; die Migration haengt hinten an der Liste.
- ~~**Deutsche Bezeichner in `WebOnboarding.svelte`**~~ erledigt, eigener Commit.
- ~~**`.agents/skills/` und `skills-lock.json`**~~ erledigt: `.agents/skills/`
  liegt seit `db06654` im Repo, eine `skills-lock.json` gibt es nicht.
- **`listEntryYears`** (`store.ts`) liest jede Monatsdatei nur zum Zaehlen.
  Entschaerft, nicht behoben - siehe `SYNC_PRELOAD.md`.
- **`isPairingCode`-Doppelung** ist erledigt (`shared/codes.ts`). Wer weitere
  sucht: gleiche Namen finden geht mit
  `grep -rhoE "^(export )?(async )?function [a-zA-Z0-9_]+" src/lib server/src`,
  gleiche LOGIK findet man so nicht - die drei Fassungen des Wire-Formats hiessen
  alle anders.
