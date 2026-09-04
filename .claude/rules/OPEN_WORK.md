# Was offen ist

Stand 2026-09-03, Branch `feat/passkey-vault`. Nach Prioritaet, nicht nach Thema.
Nichts davon ist deployt - `main` steht bei `0d72a0c`.

Offen: P2 (der Weg durch die echte PWA, von Hand) und das Ausfuehren von
`npm run reset:crypto -- --yes` beim tatsaechlichen Deployment (siehe unten).
Alles andere haengt an Tests und `svelte-check`.

**Zur Ruecksicht auf Bestandsdaten:** den Server benutzt derzeit nur eine
Person, die ihre Daten lokal hat und sich neu verknuepfen kann. Auf alte
Serverdaten muss also nichts Ruecksicht nehmen. Was der lokale Browser
mitbringt, ist die Ausnahme - dort kommt man vom Fehlerbildschirm des Starts
nicht mehr heraus (kein Knopf zum Loesen der Verknuepfung), deshalb bleibt die
einmalige Uebernahme eines alten Schluessels aus der `device.json` stehen.

## ~~Security-Review + der Fund daraus~~ erledigt

`/security-review` ueber den ganzen Branch: **keine** Sicherheitsluecke. Die
Algorithmen sind auf allen vier Entschluesselungswegen festgenagelt, die
Bindung der Datensaetze wird wirklich geprueft, die Kopplung weist einen
vertauschten Schluessel und einen vertauschten Anspruch ab, jede API-Route
haengt an `locals.userId`, und der CSP-Hash kommt aus dem Build, nicht aus
einer Anfrage.

Dabei fiel dafuer ein Fehler auf, der KEINE Sicherheitsluecke ist, aber
schwerer wog als alles, was die Review gesucht hat - behoben in `ada4ba1`:

Nach jedem Neuladen im Browser liegt auf `#key` die abgelegte, nicht-
exportierbare Kopie. `hmacWithVaultKey` holte sich die Bytes ueber
`exportKey` - fuer diese Kopie schlaegt das mit Absicht fehl. Folgen:

- `bucketFor` warf in jeder Abgleichsrunde, der Fehler wurde verschluckt:
  **der Abgleich war nach jedem Neuladen still tot.**
- `vaultProof` genauso - `unlockWithStoredKey` fiel grundlos auf die 24
  Woerter zurueck.
- `addPasskey` legte einen Passkey OHNE Verpackung an und meldete "kein
  PRF" - genau der kaputte Zustand, gegen den dieser Branch gebaut wurde.
- `approvePairing` warf mit einer DOMException.

Kein Test kam an die Stelle: `linkWithSession` bekommt ueberall einen frisch
erzeugten, exportierbaren Schluessel.

Behoben ueber Schluesseltrennung. `VaultKey` haelt zwei Schluessel aus
demselben Geheimnis - AES-GCM fuers Ver-/Entschluesseln, HMAC fuer die
abgeleiteten Kennungen. Keine Kennung braucht mehr einen Export, die Werte
selbst sind unveraendert. Wer eine NEUE Verpackung schreibt (weiterer
Passkey, weiteres Geraet), braucht die Bytes weiterhin: dafuer gibt es
`reunlockWithPasskey` - eine Bestaetigung mit dem Passkey dieses Browsers
liefert den Schluessel erneut, statt nach 24 Woertern zu fragen.
`#exportableKey()` prueft ueber den Nachweis, dass es derselbe Vault ist.

Dazu: die IndexedDB des Schluessels heisst englisch
(`timetracker-keys`/`keys`), und die zwei Stellen, die einen geschuetzten
Schluessel aus der `device.json` lasen, liegen jetzt einmal in `store.ts`
(`readProtectedVaultKey`).

**Bewusst NICHT umbenannt:** die Datei-IndexedDB in `platform/fs.ts` heisst
weiter `timetracker`/`dateien`. Der Name steht so auf `main` - ein Rename
laesst die lokalen Dateien jedes bestehenden Browsers verwaisen, und die
Regel (englische Bezeichner) meint Code, nicht Ablagenamen. Wer es trotzdem
will, braucht einen einmaligen Umzug beim Start.

**Fuer P2 kommt dazu:** einmal die Seite neu laden und nachsehen, dass der
Abgleich weiterlaeuft - danach einen Passkey anlegen und ein Geraet koppeln,
beides loest jetzt eine zusaetzliche Passkey-Bestaetigung aus.

## ~~Code-Review des JWE-Umbaus (8 Finder-Agenten)~~ erledigt

`/code-review` auf den vollen Diff der vier Commits unten losgelassen, alle
Funde am tatsaechlichen Code nachgeprueft (nicht ungeprueft uebernommen),
15 davon ueber `ReportFindings` gemeldet. Fuenf Commits daraus:

- **`65b2124`** - der schwerwiegendste Fund: ein vor diesem Branch
  verknuepftes Geraet haette beim ersten Laden nach dem Update seine
  gesamten lokalen Daten verloren (`clearAccountData()`, weil der alte
  Schluessel aus `device.json` nie in die neue Ablage uebernommen wurde).
  Dazu ein zusammenhaengender Fund-Cluster: eine Race beim Schluessel-
  Vorladen konnte echte verschluesselte Dateien mit Klartext-Leerzustand
  ueberschreiben oder faelschlich in Quarantaene schicken - der Start wirft
  jetzt sichtbar, statt still weiterzulaufen. Nebenbei: doppelter
  IndexedDB-Abruf beim Start behoben, der blockierende Verschluesselungs-
  Sweep laeuft jetzt erst nach dem Laden.
- **`faf3bd0`** - die CSP-Kopfzeile des Servers erlaubte trotz des
  Hash-Modus im Meta-Tag weiterhin pauschal `unsafe-inline` fuer
  `script-src`. Uebernimmt den Hash jetzt aus derselben Datei.
- **`cb54110`** - die drei Ver-/Entpackwege in `vault.ts` (Phrase/PRF/
  Geraet) auf einen gemeinsamen Kern zusammengelegt.
- **`a98e907`** - `fs.ts` und `keyStore.ts` teilten sich die
  IndexedDB-Verdrahtung nicht, jetzt ein gemeinsames Modul, dabei eine
  fehlende Absicherung gegen eine blockierte Verbindung nachgezogen.

**Nachtraeglich per Rebase behoben:** zwei Review-Funde betrafen bestehende
Commit-Nachrichten - `4b0152f` und `7719b59` nutzten das laut
`AI_GUIDELINES.md` verbotene Wort "Tresorschluessel" (jetzt
"Vault-Schluessel"), `dd5110a` nutzte `security(csp):` als Typ, den die
erlaubte Liste nicht kennt (jetzt `fix(csp):`). Umgeschrieben mit
`git filter-branch --msg-filter` ueber `main..HEAD`; die Bauminhalte sind
nachweislich unveraendert (`git diff` gegen den Stand davor ist leer), nur die
Nachrichten und damit alle Hashes ab `4b0152f` sind neu. Aeltere Notizen
nennen deshalb Hashes, die es nicht mehr gibt.

## ~~Krypto-Schicht auf JWE + lokale Verschlüsselung im Browser~~ erledigt

Ausgangspunkt war der unten stehende P1-Punkt (lokale Eintraege im Browser
unverschluesselt). Beim Entwurf des Formats zeigte sich, dass die drei
hand-gebauten Schluessel-Verpackungen (Wiederherstellungsphrase/PBKDF2,
Passkey-PRF/HKDF, Geraete-Kopplung/ECDH) fast 1:1 auf JWE (RFC 7516/7518,
Bibliothek `jose`) abbilden - daraus wurde ein kompletter Umbau der
Krypto-Schicht, nicht nur der neue Teil. Vier Commits, in dieser Reihenfolge:

1. **`4b0152f`** - `sealRecord`/`openRecord` (Sync-Wireformat) und die drei
   Verpackungswege auf JWE umgestellt (`alg:"dir"`, `PBES2-HS512+A256KW`,
   `A256GCMKW`, `ECDH-ES+A256KW`). `packSealed`/`unpackSealed`,
   `serializeWrap`/`deserializeWrap`, `wrapWith`/`unwrapWith`, `kekFromPhrase`,
   `kekFromEcdh`, `KeyWrap`/`Sealed` ersatzlos weg - der JWE-Compact-String ist
   bereits das fertige Wire-Format. Server unveraendert (prueft `payload`/
   `wrapped_key` nie inhaltlich, nur Laenge).
2. **`7719b59`** - lokale Ablage im Browser verschluesselt (`activities.json`,
   `settings.json`, `entries-*.json`, `timereport-*.json`; `device.json`/
   `outbox.json` bleiben Klartext). Schluessel-Persistenz: nicht-exportierbarer
   `CryptoKey` in einer eigenen IndexedDB (`platform/keyStore.ts`) statt
   lesbarer Bytes in `device.json` - `exportKey` schlaegt dafuer fuer immer
   fehl, eine Zusage der Web-Crypto-Spezifikation. Migration: alte
   Klartextdateien lesen sich weiter, werden beim naechsten Speichern
   verschluesselt, dazu ein einmaliger Nachhol-Durchlauf beim Start
   (`DeviceInfo.localFilesEncrypted`).
3. **`11810e9`** - `server/scripts/reset-crypto-data.ts`
   (`npm run reset:crypto -- --yes`, Server-Verzeichnis): leert `records`,
   `key_wraps`, `pairings` - mit dem neuen Format unlesbare Altdaten. **Noch
   nicht gegen die echte Server-DB ausgefuehrt**, das ist ein bewusst
   getrennter, von Hand anzustossender Schritt beim Deployment.
4. **`dd5110a`** - `script-src` der CSP ohne pauschales `unsafe-inline`
   (SvelteKits CSP-Hash-Modus, `svelte.config.js`). Die CSP selbst gab es
   schon (`server/src/hooks.server.ts`) - das war eine falsche Annahme
   unterwegs, korrigiert.

Dazu `c9243cc`: `scripts/recover-probe.ts`/`docker-smoke-test.ts` ans neue
Wireformat angepasst (waren sonst kaputt, kein `svelte-check`/`vitest` deckt
`scripts/` ab) und komplett auf englische Bezeichner umbenannt (waren
durchgehend deutsch, kein `svelte-check` haette das gemeldet).

**Akzeptierte Konsequenz:** jede vor `4b0152f` synchronisierte Zeiterfassung
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

`checkPairing` reicht `answer.userId` durch (`63ed122`), und `#persistLink`
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

Danach nach `main` und deployen. Der Fix aus `058f86b` wirkt nur fuer NEUE
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
- ~~**`listEntryYears`** (`store.ts`) liest jede Monatsdatei nur zum Zaehlen.~~
  erledigt (`938145a`). Im Browser lief das fuer nichts: die Karte "Daten auf
  diesem Geraet" steht unter `{#if isTauri()}`, der `$effect` in `SystemTab`
  nicht. Jetzt haengt er an derselben Bedingung. Auf dem Rechner bleibt das
  Lesen - die exakte Zahl der Eintraege steht nirgends sonst, und der Aufruf
  faellt nur bei offenem Tab an.
- ~~**Fehlerbildschirm des Starts hat keinen Weg zurueck.**~~ erledigt
  (`938145a`). "Anmeldung zuruecksetzen" mit einer zweiten Frage davor (kein
  Dialog - auf diesem Bildschirm soll so wenig wie moeglich haengen), nur im
  Browser. `account.forgetLink()` setzt die zwei Schritte zusammen, die
  `unlink()` auch macht, ohne den Teil, der einen Server braucht.
- **`isPairingCode`-Doppelung** ist erledigt (`shared/codes.ts`). Wer weitere
  sucht: gleiche Namen finden geht mit
  `grep -rhoE "^(export )?(async )?function [a-zA-Z0-9_]+" src/lib server/src`,
  gleiche LOGIK findet man so nicht - die drei Fassungen des Wire-Formats hiessen
  alle anders.
