// Durchstich gegen den laufenden Container, mit dem ECHTEN Krypto-Code des
// Clients: Konto anlegen, Phrase hinterlegen, Daten hochladen, alles verlieren -
// und mit 24 Woertern wieder hereinkommen.
import {
	createRecoveryPhrase,
	createVaultKey,
	exportVaultKey,
	recoveryLookupId,
	toBase64,
	unwrapWithPhrase,
	vaultProof,
	wrapWithPhrase
} from "../src/lib/crypto/vault";

const BASIS = process.env.TT_BASIS ?? "http://127.0.0.1:3000";
const EINLADUNG = process.env.TT_EINLADUNG ?? "probe-2026";

let fehler = 0;
function pruefe(was: string, bedingung: boolean, zusatz = ""): void {
	console.log(`${bedingung ? "  ok  " : " FEHL "} ${was}${zusatz ? ` — ${zusatz}` : ""}`);
	if (!bedingung) fehler++;
}

async function ruf(pfad: string, body: unknown, token?: string) {
	const res = await fetch(`${BASIS}${pfad}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {})
		},
		body: JSON.stringify(body)
	});
	return { status: res.status, daten: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

/** Abbrechen mit Bilanz - sonst stirbt das Skript an einem Folgefehler. */
function abbrechen(grund: string): never {
	console.log(`\n Abbruch: ${grund}`);
	console.log(`\n${fehler} FEHLER\n`);
	process.exit(1);
}

console.log("\n=== Konto anlegen, verlieren, zurueckholen ===\n");

// 1. Konto vom Rechner aus anlegen
const angelegt = await ruf("/api/auth/device", { label: "Alter Rechner", invite: EINLADUNG });
pruefe("Konto angelegt", angelegt.status === 200, `Status ${angelegt.status}`);
const token = angelegt.daten?.deviceToken;
if (typeof token !== "string") {
	abbrechen(`kein Geraete-Token — Einladung "${EINLADUNG}" gueltig? (TT_EINLADUNG setzen)`);
}

// 2. Phrase erzeugen und ablegen - wie die Anwendung es tut
const key = await createVaultKey();
const phrase = createRecoveryPhrase();
const wrapAb = await ruf(
	"/api/wraps",
	{
		kind: "recovery",
		payload: await wrapWithPhrase(key, phrase),
		recoveryId: await recoveryLookupId(phrase),
		vaultProof: await vaultProof(key)
	},
	token
);
pruefe("Phrase hinterlegt", wrapAb.status === 200, `Status ${wrapAb.status}`);

// 3. Etwas hochladen
const hoch = await ruf(
	"/api/sync",
	{ records: [{ id: "e1", kind: "entry", bucket: "abc", baseRev: 0, updatedAt: 1, payload: "eA==" }] },
	token
);
pruefe("Daten hochgeladen", hoch.status === 200, `Status ${hoch.status}`);

console.log("\n-- Der Rechner ist jetzt kaputt. In der Hand: 24 Woerter. --\n");

// 4. Kennung rechnen, Verpackung holen
const id = await recoveryLookupId(phrase);
const geholt = await ruf("/api/auth/recover", { recoveryId: id });
const verpackung = geholt.daten?.wrap;
pruefe("Verpackung gefunden", geholt.status === 200 && typeof verpackung === "string");
pruefe("Dabei KEIN Token", geholt.daten?.deviceToken === undefined);
if (typeof verpackung !== "string") {
	abbrechen("der Server gibt zu dieser Kennung keine Verpackung heraus");
}

// 5. Oeffnen und nachweisen
let zurueck;
try {
	zurueck = await unwrapWithPhrase(verpackung, phrase);
} catch (e) {
	pruefe("Verpackung geoeffnet", false, e instanceof Error ? e.name : String(e));
	abbrechen("die Verpackung geht mit ihrer eigenen Phrase nicht auf");
}
pruefe("Verpackung geoeffnet", true);
pruefe(
	"Derselbe Tresorschluessel",
	toBase64(new Uint8Array(await exportVaultKey(zurueck))) ===
		toBase64(new Uint8Array(await exportVaultKey(key)))
);

const neu = await ruf("/api/auth/recover", {
	recoveryId: id,
	proof: await vaultProof(zurueck),
	label: "Neuer Rechner"
});
pruefe("Neues Geraet angemeldet", neu.status === 200, `Status ${neu.status}`);
const neuesToken = neu.daten?.deviceToken;
if (typeof neuesToken !== "string") abbrechen("der Nachweis brachte kein Geraete-Token");

// 6. Die Daten sind da
const seite = await fetch(`${BASIS}/api/sync?since=0`, {
	headers: { authorization: `Bearer ${neuesToken}` }
});
const inhalt = (await seite.json().catch(() => null)) as { records?: unknown[] } | null;
pruefe("Die Daten sind noch da", inhalt?.records?.length === 1);

// 7. Eine falsche Phrase fuehrt nirgendwohin
const falsch = await ruf("/api/auth/recover", {
	recoveryId: await recoveryLookupId(createRecoveryPhrase())
});
pruefe("Fremde Phrase findet nichts", falsch.status === 404, `Status ${falsch.status}`);

console.log(`\n${fehler === 0 ? "Alles grün." : `${fehler} FEHLER`}\n`);
process.exit(fehler === 0 ? 0 : 1);
