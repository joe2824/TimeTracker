# Was offen ist

Stand 2026-09-03, Branch `feat/passkey-vault`. Nach Prioritaet, nicht nach Thema.
Nichts davon ist deployt - `main` steht bei `0d72a0c`.

Offen ist nur noch P2: der Weg durch die echte PWA, von Hand. Alles andere
haengt an Tests und `svelte-check`.

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

Offen und AELTER als dieser Branch: **die lokalen Eintraege liegen im Browser
unverschluesselt** (`store.ts:85`, IndexedDB). Das ist der Grund, warum die
Frage nach dem liegenden Vault-Key so wenig Gewicht hat - und der eigentliche
Punkt, wenn jemand das ernst nehmen will.

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
