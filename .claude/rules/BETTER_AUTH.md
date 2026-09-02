# Umbau auf Better Auth — Plan

Status: **Plan steht, Umbau nicht begonnen.** Branch `feat/better-auth`.
Diese Datei liegt im Repo, damit die Arbeit auf einer anderen Maschine
(`git pull`) genau hier weitergehen kann.

Vorbedingung, schon erledigt: Commit `67d55cc`
("passkey verpackt den vault-key schon beim anlegen"). Der Fix haengt NICHT am
Umbau und kann jederzeit nach `main` gecherrypickt werden.

## Warum ueberhaupt

Die Anmeldung ist mehrfach hintereinander kaputtgegangen: Passkey meldet an,
oeffnet die Daten aber nicht; danach verlangt jeder neue Browser die 24 Woerter.
Die Ursache lag jedes Mal in selbstgebautem Standardkram - Challenge-Ablage,
Sitzungs-Cookies, Zeremonie-Reihenfolge. Das ist geloester Kram; wir wollen ihn
nicht mehr selbst pflegen.

Better Auth uebernimmt genau diesen Teil. Es laeuft selbst auf SimpleWebAuthn,
also derselben Bibliothek, die hier schon liegt.

## Die Grenze — was Better Auth NICHT anfasst

Der Satz, an dem der ganze Plan haengt:

> **Better Auth meldet an. Es entschluesselt nicht.**

Der Vault-Key wird nie an den Server gereicht - auch nicht an Better Auth. Was
bleibt vollstaendig unser Code:

| Bleibt | Warum |
|---|---|
| `key_wraps` samt Transaktions-Semantik | Eine Verpackung je Passkey, `recoveryId` eindeutig, `vaultProof` nur als Hash |
| `wrapWithPrf` / `unwrapWithPrf` / BIP39-Phrase | Reine Client-Kryptographie |
| `ensurePasskeyWrap` | Der Nachlauf, weil `create()` meist keinen PRF-Wert liefert |
| `devices`, `pairings` + Geraete-Token | Der Desktop weist sich mit Token aus, nicht mit Cookie |
| `records`, Sync-Engine, Buckets | Hat mit Anmeldung nichts zu tun |
| `invites`, `telemetry_pings`, `server_settings`, Backups | Unsere Fachlichkeit |

**Wichtig:** Dieser Umbau behebt den Entschluesselungs-Bug NICHT. Der ist in
`67d55cc` behoben. Better Auth liefert die PRF-Ergebnisse (`returnWebAuthnResponse`),
`ensurePasskeyWrap` bleibt unveraendert die Stelle, die daraus die Verpackung
macht. Wer das beim Umbau wegwirft, holt sich den Bug zurueck.

## Bekommt Better Auth unsere Daten? Nein.

Better Auth ist eine npm-Bibliothek, kein gehosteter Dienst. Sie laeuft auf
unserem Server und schreibt in unsere SQLite-Datei. Kein Konto, kein API-Key,
kein Aufruf nach draussen - genau wie `@simplewebauthn/server`, das ohnehin
schon hier liegt und das Better Auth selbst benutzt.

Drei Punkte, die trotzdem festzuhalten sind:

- **Telemetrie.** Existiert (`/docs/reference/telemetry`), ist standardmaessig
  AUS und opt-in. Sammelt anonym Runtime, Framework, DB-Art, System-Eckdaten;
  ausdruecklich keine Mails, Token, Secrets oder DB-URLs. Wir setzen trotzdem
  `BETTER_AUTH_TELEMETRY=0` in der Serverumgebung, statt uns auf den Default zu
  verlassen. Pruefbar mit `BETTER_AUTH_TELEMETRY_DEBUG=1` (loggt nur auf die
  Konsole, sendet nichts).
- **Der MCP-Doku-Server** ist Entwicklungs-Werkzeug, kein Teil der Anwendung.
  Er bekommt Suchbegriffe, keine Daten.
- **Die Ende-zu-Ende-Verschluesselung bleibt unberuehrt.** Der Vault-Key
  verlaesst den Client nicht - auch nicht Richtung eigener Server. Better Auth
  sitzt in der Anmeldeschicht, die den Key ohnehin nie anfasst. Siehe die Grenze
  oben.

## Was Better Auth uebernimmt

- `credentials`-Tabelle (wird `passkey`), Challenge-Ablage (wird `verification`),
  `sessions` (wird `session`)
- `POST /api/auth/register/{start,finish}`, `login/{start,finish}`,
  `passkeys/{start,finish}`, `logout`
- `server/src/lib/server/webauthn.ts` und die WebAuthn-Haelfte von
  `server/src/lib/server/auth.ts` (`storeChallenge`, `takeChallenge`,
  `createSession`, `userFromSession`)
- clientseitig: die WebAuthn-Zeremonien in `src/lib/sync/enroll.ts`

## Versionen

```
better-auth                 1.7.2
@better-auth/passkey        1.7.2
@better-auth/drizzle-adapter 1.7.2
```

Passt zu SvelteKit 2.9, drizzle-orm 0.45.2, better-sqlite3 12.4.1.

Neue Pflicht-Umgebungsvariable: **`BETTER_AUTH_SECRET`**. Better Auth weist
Platzhalter-Werte in Produktion zurueck. Das ist NICHT unser `HMAC_SECRET` -
beide werden gebraucht, `HMAC_SECRET` haengt weiter an den Geraete-Token. In
`docker-compose`, `.env.example` und der Wiki-Doku nachziehen, sonst startet der
Server nach dem Update nicht.

## Schritt 0: Spike — VOR allem anderen

Vier Annahmen tragen den Plan. Stimmt eine nicht, aendert sich der Weg. Deshalb
zuerst ein Wegwerf-Zweig, der nur diese vier Fragen beantwortet:

1. **Darf `user.email` NULL sein?** Unsere Konten sind passkey-only, `email` ist
   freiwillig (`schema.ts`). Better Auths Kernschema will `email`. Wenn es
   NOT NULL braucht: Platzhalter (`<userId>@local.invalid`) oder eigenes
   Feld-Mapping. Muss VOR der Migration feststehen.
2. **Laesst sich `user` auf unsere `users`-Tabelle legen?** Ueber
   `user: { modelName: "users", fields: { name: "display_name" }, additionalFields: {...} }`.
   Wenn ja, behalten alle Konten ihre `id` - und damit bleiben `records.user_id`,
   `key_wraps.user_id`, `devices.user_id` unangetastet. Das ist der ganze
   Unterschied zwischen "Schema-Migration" und "Datenmigration".
3. **In welcher Form legt die `passkey`-Tabelle den Public Key ab?**
   Unsere `credentials.public_key` ist `blob`. Wenn Better Auth `text`
   (base64url) will, braucht die Migration eine Umrechnung - und die muss
   stimmen, sonst meldet sich hinterher niemand mehr an.
4. **Laesst sich die Anmelde-Aufgabe vorladen?** `authClient.signIn.passkey()`
   holt die Options INNERHALB des Aufrufs. Genau dagegen ist `bef5b2f` gebaut:
   im Mobilfunk laeuft die User-Activation aus dem Klick ab, bevor der Dialog
   aufgeht, und der Browser wirft `NotAllowedError`. Zu pruefen, in dieser
   Reihenfolge:
   - Gibt es einen Options-Endpunkt, den man selbst vorher rufen kann?
   - Sonst: `autoFill: true` (Conditional UI) - der Browser armiert dann vorab.
   - Sonst: eigener duenner Aufruf an den Options-Endpunkt plus
     `startAuthentication` von Hand, Verifikation ueber Better Auth.

   Ohne Antwort auf 4 wird die Anmeldung im Mobilfunk wieder schlechter als
   heute. Das ist ein Blocker, keine Feinheit.

Ergebnis des Spikes in diese Datei eintragen, dann erst Schritt 1.

## Schritt 1: Better Auth danebenstellen, nichts abschalten

`server/src/lib/server/betterAuth.ts`:

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { getRequestEvent } from "$app/server";

export const auth = betterAuth({
	database: drizzleAdapter(db, { provider: "sqlite" }),
	user: {
		modelName: "users",
		fields: { name: "display_name" },
		additionalFields: {
			seqCounter: { type: "number", input: false },
			isAdmin: { type: "boolean", input: false },
			recoveryId: { type: "string", required: false, input: false },
			vaultProof: { type: "string", required: false, input: false }
		}
	},
	plugins: [
		passkey({
			rpID: RP_ID,
			rpName: "TimeTracker",
			origin: ORIGIN,
			registration: {
				// Konto entsteht MIT dem Passkey, nicht davor.
				requireSession: false,
				resolveUser: async ({ context }) => {
					// `context` traegt den Einladungscode. Hier faellt die
					// Entscheidung, ob ein Konto entstehen darf.
				}
			}
		}),
		// Muss letzter Eintrag sein.
		sveltekitCookies(getRequestEvent)
	]
});
```

`hooks.server.ts` bekommt den Handler dazu, die alten Routen bleiben vorerst
stehen. Ziel dieses Schritts: der Server startet, `npx auth@latest generate`
laeuft durch, und die alten Tests sind noch gruen.

`isAdmin` und `seqCounter` bekommen `input: false` - sonst koennte sich jemand
ueber die Registrierung selbst zum Verwalter machen.

## Schritt 2: Schema und Datenmigration

`npx auth@latest generate` erzeugt das Drizzle-Schema, danach
`npx drizzle-kit generate` und `migrate`. **Das generierte Schema nicht blind
uebernehmen** - es muss auf die bestehenden Tabellen zeigen (Schritt 0, Frage 2).

Einmalige Datenmigration `credentials` -> `passkey`:

| alt | neu | Anmerkung |
|---|---|---|
| `id` | `credentialID` | base64url, unveraendert |
| `public_key` (blob) | `publicKey` | Format aus Spike 3 |
| `counter` | `counter` | |
| `transports` | `transports` | |
| `label` | `name` | |
| `user_id` | `userId` | |
| `created_at` | `createdAt` | |
| `has_prf` | — | **faellt weg** |

`has_prf` war nur Anzeige. Was die Verwaltung wirklich braucht, ist `hasWrap` -
und das kommt aus `key_wraps`, nicht aus dem Authentifikator. Eine Spalte
weniger, die auseinanderlaufen kann.

`sessions` wird nicht migriert: alle melden sich einmal neu an. `challenges`
faellt ersatzlos weg.

## Schritt 3: Der Client

`src/lib/sync/authClient.ts`:

```ts
import { createAuthClient } from "better-auth/svelte";
import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({ plugins: [passkeyClient()] });
```

`enroll.ts` schrumpft auf das, was wirklich unseres ist:

```ts
// bleibt
prfBytes, prfOf, PRF_INPUT, serialize, deserialize,
openWithPhrase, openWithPrf, ensurePasskeyWrap,
unlockWithPhrase, recoverWithPhrase, registerFromDevice

// geht an Better Auth
prepare/forget (Challenge-Puffer), withPrf, toBase64Url,
die startRegistration/startAuthentication-Aufrufe
```

`register()` wird:

```ts
const r = await authClient.passkey.addPasskey({
	context: invite,            // Einladungscode -> resolveUser
	createSession: true,
	extensions: { prf: { eval: { first: PRF_INPUT } } },
	returnWebAuthnResponse: true
});
const prf = prfOf(r.data.webAuthnResponse);
// AB HIER unveraendert: recovery-Verpackung, dann ensurePasskeyWrap
```

`login()` analog mit `authClient.signIn.passkey({ extensions, returnWebAuthnResponse })`.

**`prfOf` bleibt.** Die PRF-Ausgabe kommt je nach Browser als ArrayBuffer, als
Ansicht, als base64 oder als durchnummeriertes Objekt - Better Auth normalisiert
das nicht. `prf.test.ts` bleibt gueltig.

## Schritt 4: Zwei Wege in `hooks.server.ts`

Der Desktop hat keinen Cookie. Die Aufloesung wird:

```ts
// 1. Better Auth
const session = await auth.api.getSession({ headers: event.request.headers });
if (session) locals.userId = session.user.id;
// 2. sonst unser Geraete-Token (unveraendert)
else locals.userId = deviceFromToken(db, event.request.headers)?.userId;
```

Better Auth erfaehrt von den Geraeten nichts und muss es auch nicht. Alles unter
`/api/sync`, `/api/wraps`, `/api/pair`, `/api/devices` liest weiter nur
`locals.userId` und aendert sich gar nicht.

## Schritt 5: Aufraeumen

Erst wenn Schritt 1-4 im Browser durchgeklickt sind:

- Routen weg: `api/auth/register/*`, `api/auth/login/*`, `api/passkeys/*`,
  `api/auth/logout`
- `server/src/lib/server/webauthn.ts` weg
- aus `auth.ts` weg: `storeChallenge`, `takeChallenge`, `createSession`,
  `userFromSession`, `SESSION_COOKIE`
- **bleibt in `auth.ts`**: `hashSecret`, `sha256Hex`, `newSecret`, `safeEqual`,
  `deviceFromToken`, alles zur Kopplung
- Tabellen `challenges`, `sessions`, `credentials` droppen — in einer EIGENEN
  Migration, nachdem die neue Anmeldung nachweislich laeuft
- `@simplewebauthn/server` aus `server/package.json`;
  `@simplewebauthn/browser` bleibt (`ensurePasskeyWrap` ruft es direkt)

## Schritt 6: Tests

- `server/src/lib/server/webauthn.test.ts` faellt weg
- `api.test.ts` zieht auf die Better-Auth-Endpunkte um (**Achtung:** laeuft gegen
  `server/build/handler.js`, braucht also vorher `npm run build` im `server/`)
- `src/lib/sync/enroll.test.ts` bleibt inhaltlich gleich, mockt aber
  `authClient` statt `./api`. Die vier Faelle muessen weiter stehen:
  Verpackung entsteht ohne PRF beim Anlegen; keine Doppelabfrage wenn er da war;
  Konto entsteht auch ohne PRF; Login oeffnet mit dem, was `register` hinterlegt hat
- `prf.test.ts`, `vault.test.ts`, `detach.test.ts`, `accountIsolation.test.ts`
  bleiben unberuehrt

## Risiken

- **Spike 4 (Vorladen).** Groesstes Risiko. Ohne Antwort wird die Anmeldung im
  Mobilfunk schlechter als heute.
- **Public-Key-Format.** Falsch umgerechnet meldet sich nach der Migration
  niemand mehr an. Vor dem Deployment gegen eine Kopie der echten DB pruefen.
- **`isAdmin` ueber die Registrierung.** `input: false` nicht vergessen.
- **Cookie-Name aendert sich.** Alle sind einmal abgemeldet. Auf dem Desktop
  passiert nichts - der haengt am Geraete-Token.
- **Zwei Migrationen, nicht eine.** Erst anlegen und fuellen, deployen,
  nachweisen; dann in einem zweiten Schritt die alten Tabellen droppen.
  Sonst gibt es keinen Weg zurueck.

## Rollback

Bis Schritt 5 ist der Weg zurueck ein `git revert` - die alten Routen stehen
noch. Ab Schritt 5 braucht es das Backup. `startBackupScheduler` laeuft; vor
dem Drop-Schritt zusaetzlich von Hand sichern.

## Baureihenfolge

1. Schritt 0 (Spike) — ohne den nichts
2. Schritt 1 + 2 (Server danebenstellen, Schema)
3. Schritt 3 + 4 (Client, zwei Wege)
4. Im Browser durchklicken: Konto anlegen, in einem zweiten Browserprofil
   anmelden, Desktop koppeln, abmelden, wieder anmelden
5. Schritt 5 + 6 (Aufraeumen, Tests)

## Namenskonvention

Gilt weiter (siehe `SYNC_PRELOAD.md`): Bezeichner immer Englisch, Deutsch nur in
Kommentaren, UI-Texten und Commit-Messages.

Offen und unabhaengig von diesem Umbau: in
`src/lib/components/onboarding/WebOnboarding.svelte` stehen noch deutsche
Bezeichner, die die Rename-Wellen uebersehen haben — `fehlertext`, `phraseOffen`,
`phraseEingabe`, `zurueckholen`, `kopplungscode`, `koppelnOffen`,
`koppelnAbbrechen`, `koppelnAufraeumen`, `pruefen`, Step `"geraet"`.
Eigener Commit, nicht nebenbei.

## Doku

Better Auth hat einen MCP-Server mit der eigenen Doku:

```
claude mcp add --transport http better-auth https://mcp.better-auth.com/mcp
```

Werkzeuge: `search_docs`, `get_doc`. Relevante Seiten:
`/docs/plugins/passkey`, `/docs/adapters/drizzle`,
`/docs/integrations/svelte-kit`, `/docs/concepts/database`,
`/docs/concepts/session-management`.

---

# Teil 2: Die Verschluesselung so bauen, dass es nicht wiederkommt

## Der Zustand, den es nicht geben darf

Fuer jeden Passkey eines Kontos gilt genau eines von beidem:

- **verpackt** — in `key_wraps` liegt eine Zeile dazu
- **kann kein PRF** — nach einer ECHTEN Anmeldung stand fest, dass der
  Authentifikator keinen Wert liefert

Der dritte Zustand — **weder noch** — ist der Bug. Jeder Fehler der letzten
Wochen war eine neue Auspraegung davon: `5671928` (addPasskey), `67d55cc`
(register). Nicht dieselbe Stelle, derselbe Zustand.

## Warum es immer wiederkam

Drei Dinge, die einzeln harmlos sind und zusammen genau dieses Muster erzeugen:

**1. Passkey und Verpackung entstehen in zwei getrennten Anfragen.**
`registerFinish` legt den Passkey an, `putWrap` die Verpackung. Dazwischen kann
alles passieren: Netz weg, Tab zu, Deckel zu. Dann steht der Passkey und die
Verpackung fehlt. Und weil es zwei Schritte sind, muss JEDER neue Weg, der einen
Passkey anlegt, an den zweiten denken. Genau das ist zweimal schiefgegangen.

**2. Der Fehlschlag ist still.** Ueberall `.catch(logWarn)`. Der kaputte Zustand
entsteht, ohne dass irgendwer etwas merkt - auch nicht der, der ihn gerade
erzeugt hat.

**3. Die Folge kommt bis zu 30 Tage spaeter.** `SESSION_TTL_MS` ist 30 Tage
(`server/src/lib/server/config.ts:137`) und laeuft NICHT mit: `userFromSession`
verlaengert nichts. Und beim 401 raeumt `restore()` den lokalen Vault-Key weg
(`#forgetLocally` schreibt `saveDevice({ id })`). Bis dahin laeuft alles, weil
der Key lokal liegt.

Punkt 3 ist die eigentliche Antwort auf "warum immer wieder". Zwischen der
Aenderung, die den Bug einbaut, und dem Moment, in dem jemand ihn sieht, liegt
ein Monat. Kein Test faengt das, und Ausprobieren von Hand auch nicht: ein frisch
angelegtes Konto funktioniert 30 Tage lang tadellos. Der Passkey ist dann das
EINZIGE, was noch zwischen dem Anwender und den 24 Woertern steht - und ob er
das kann, hat einen Monat lang niemand geprueft.

## Was daraus folgt

### A. Eine Anfrage, eine Transaktion

Die Verpackung ist fuer den Server undurchsichtige Bytes - er kann sie
entgegennehmen, ohne irgendetwas zu erfahren. Also: Passkey und Verpackung in
DERSELBEN Anfrage, und serverseitig in einer `db.transaction`. Entweder beides
oder nichts. Damit ist "weder noch" bei der Entstehung nicht mehr darstellbar.

Offen (Spike 5): Better Auths Passkey-Plugin besitzt den Verify-Endpunkt. Es gibt
`registration.afterVerification` - zu pruefen, ob der Haken zusaetzliche
Body-Felder sieht und ob ein Wurf dort die Registrierung zurueckrollt. Wenn
nicht, bleibt es bei zwei Anfragen, und B + C muessen es auffangen.

### B. Der Weg zurueck ist automatisch, nicht manuell

Steht ein Passkey ohne Verpackung da, gilt der Reihe nach:

1. Liegt der Vault-Key hier (lokal, oder eine andere Verpackung geht auf)?
   Dann still reparieren - ohne Rueckfrage, ohne Bildschirm.
2. Sonst: Phrase oder Kopplung, und dabei reparieren.
   Das tut `unlockWithPhrase(url, phrase, repair)` seit `67d55cc`.

Schritt 1 fehlt heute. Wer den Vault-Key hat, soll nie einen Entsperren-Bildschirm
sehen.

### C. `hasPrf` faellt weg, `wrapState` kommt

`credentials.has_prf` wird aus der ANLEGE-Antwort gesetzt - genau dem Signal, das
dokumentiert unzuverlaessig ist. Dasselbe falsche Signal, an dem `prfCapable`
haengengeblieben ist. Ersatz, serverseitig aus `key_wraps` gerechnet:

| Wert | Bedeutung |
|---|---|
| `linked` | Verpackung liegt vor |
| `unsupported` | Nach einer echten Anmeldung stand fest: kein PRF |
| `pending` | Weder noch — **der kaputte Zustand** |

`pending` ist nichts, was man wegklicken kann. `PasskeyNudge` prueft heute
kontoweit (`passkeys.every(p => !p.hasWrap)`) und uebersieht damit "einer von
drei ist kaputt". Muss je Passkey gelten.

### D. Die Rueckkopplung verkuerzen

- **Gleitende Sitzung.** Better Auth kann das von Haus aus (`expiresIn` +
  `updateAge`, siehe `/docs/concepts/session-management`). Wer die App benutzt,
  wird nicht mehr abgemeldet - und der Ablauf ist nicht mehr der Moment, in dem
  ein einen Monat alter Bug hochkommt.
- **Ausdruecklich NICHT:** den lokalen Vault-Key beim 401 liegen lassen. Das
  wuerde jeden dieser Bugs verstecken statt beheben, und es weicht eine
  Sicherheitseigenschaft auf, die gerade erst nachgezogen wurde (`ac9df43`).
  Der richtige Weg ist, dass der Ablauf harmlos ist - nicht, dass er nicht
  auffaellt.

### E. Der Test, der gefehlt hat

Kein Happy-Path-Test, sondern eine Tabelle ueber die Zustaende. Jede Art, wie ein
Passkey entsteht, mal jede Kombination der beiden PRF-Signale:

| Entsteht durch | PRF beim Anlegen | PRF beim Anmelden | erwartet |
|---|---|---|---|
| `register` | nein | ja | `linked` |
| `register` | ja | — | `linked` |
| `register` | nein | nein | `unsupported` |
| `addPasskey` | nein | ja | `linked` |
| `addPasskey` | ja | — | `linked` |
| `addPasskey` | nein | nein | `unsupported` |
| nach `recoverWithPhrase` | nein | ja | `linked` |
| nach Kopplung | nein | ja | `linked` |

`enroll.test.ts` deckt davon heute drei Zeilen ab. Die Tabelle macht die
Luecken sichtbar - und jede neue Art, einen Passkey anzulegen, bekommt eine
Zeile, bevor sie gebaut wird.

Dazu ein Servertest: nach einer erfolgreichen Registrierung darf es keine Zeile
in `credentials`/`passkey` geben, zu der keine Zeile in `key_wraps` gehoert.

## Reihenfolge

C und E haengen nicht am Better-Auth-Umbau und koennen sofort gebaut werden - sie
sind auch dann richtig, wenn der Umbau scheitert. A haengt an Spike 5. B und D
kommen mit dem Umbau.
