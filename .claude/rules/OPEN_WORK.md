# Was offen ist

Stand 2026-09-02, Branch `feat/passkey-vault`. Nach Prioritaet, nicht nach Thema.
Nichts davon ist deployt - `main` steht bei `0d72a0c`.

## P0 — Sicherheit, eine Zeile

**`checkPairing` gibt die Kontokennung nicht weiter.**
`src/lib/sync/account.svelte.ts:883`

`#persistLink` schreibt `accountUserId: userId ?? info.accountUserId` (:1016).
`checkPairing` ist der einzige Aufrufer ohne `userId` - alle anderen wurden in
diesem Branch nachgezogen. Folge: ein Browserprofil, das zuletzt an Konto A hing
und dann zu Konto B gekoppelt wird, traegt `accountUserId: "A"` neben
`vaultKey: K_B`. `unlockWithStoredKey` (:937) haengt allein an diesem Feld und
gibt A dann B's Schluessel.

Weil danach `fingerprint === accountFingerprint` gilt, greift `foreignCopy`
nicht: B's entschluesselte Eintraege bleiben liegen, werden A gezeigt und sind
zum Hochladen in A's Konto freigegeben. A's eigene Datensaetze gehen unter K_B
nicht auf und werden still verworfen (`engine.ts:603`). Und
`repairPasskeyWrap` legt `wrapWithPrf(K_B, A's PRF)` in A's `key_wraps` -
dauerhaft, der Server kann das nicht pruefen.

Vier Bedingungen muessen zusammenkommen (geteiltes Profil, B ueber Kopplung
verknuepft, B's Geraet spaeter widerrufen, A's naechste Anmeldung ohne
Verpackung). Selten, aber jeder Schritt ist ein normaler Weg.

Zu tun:

1. `answer.userId` durchreichen - liegt schon vor (`api.ts:512`):
   `await this.#persistLink(url, answer.deviceToken, key, "", answer.userId);`
2. Absicherung in `#persistLink`: bei einem Wechsel nichts erben -
   `accountUserId: userId ?? (switched || foreignCopy ? undefined : info.accountUserId)`
3. Fall in `storedKey.test.ts` ergaenzen. Die drei vorhandenen decken
   Kennung-falsch und Kennung-fehlt ab, nicht Kennung-veraltet.

## P1 — die Sitzung laeuft nicht mit

`SESSION_TTL_MS` sind 30 Tage (`server/config.ts:138`), und `userFromSession`
(`server/auth.ts:81`) verlaengert nicht. Dieser Branch laesst beim 401 den
Vault-Key liegen, damit niemand die 24 Woerter braucht - ohne die gleitende
Sitzung, die dazugehoert.

Das ist kein Loch (wer ans Browserprofil kommt, liest die Eintraege ohnehin
direkt aus IndexedDB - sie liegen dort im Klartext), aber die Haelfte einer
Massnahme. Entweder:

- `expiresAt` in `userFromSession` mitziehen, dann ist der Ablauf kein Fall mehr
  fuer den taeglichen Nutzer, ODER
- beim 401 wenigstens `clearAccountData()` und `app.clearLocalData()` rufen, den
  Schluessel behalten.

Getrennt davon und aelter als dieser Branch: **die lokalen Eintraege liegen im
Browser unverschluesselt** (`store.ts:85`, IndexedDB). Das ist der Grund, warum
die Frage nach dem liegenden Schluessel so wenig Gewicht hat - und der
eigentliche Punkt, wenn jemand das ernst nehmen will.

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

- **`PasskeyNudge` prueft kontoweit.** `passkeys.every((p) => !p.hasWrap)`
  (`PasskeyNudge.svelte:43`) uebersieht "einer von drei ist kaputt". Muss je
  Passkey gelten.
- **`credentials.has_prf` weg.** Der Wert kommt aus der Anlege-Antwort, dem
  Signal, das dokumentiert unzuverlaessig ist - dasselbe, an dem `prfCapable`
  haengengeblieben war. Was zaehlt, ist `hasWrap` aus `key_wraps`, und das steht
  schon. Spalte und Feld raus.
- **Deutsche Bezeichner in `WebOnboarding.svelte`**: `fehlertext`, `phraseOffen`,
  `phraseEingabe`, `zurueckholen`, `kopplungscode`, `koppelnOffen`,
  `koppelnAbbrechen`, `koppelnAufraeumen`, `pruefen`, Step `"geraet"`. Die
  Rename-Welle `2e7d1b1` hat die Datei angefasst und diese stehen lassen. Eigener
  Commit.
- **`.agents/skills/` und `skills-lock.json`** liegen untracked im Repo.
  Committen oder in `.gitignore` - nicht von mir angelegt.
- **`listEntryYears`** (`store.ts`) liest jede Monatsdatei nur zum Zaehlen.
  Entschaerft, nicht behoben - siehe `SYNC_PRELOAD.md`.
- **`isPairingCode`-Doppelung** ist erledigt (`shared/codes.ts`). Wer weitere
  sucht: gleiche Namen finden geht mit
  `grep -rhoE "^(export )?(async )?function [a-zA-Z0-9_]+" src/lib server/src`,
  gleiche LOGIK findet man so nicht - die drei Fassungen des Wire-Formats hiessen
  alle anders.
