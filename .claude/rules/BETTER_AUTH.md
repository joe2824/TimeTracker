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
