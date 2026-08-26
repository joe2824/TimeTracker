// Der ganze Weg zurueck, gegen den laufenden Container - mit echtem Krypto-Code.
import {
	createRecoveryPhrase, createVaultKey, wrapWithPhrase, unwrapWithPhrase,
	recoveryLookupId, vaultProof, exportVaultKey, toBase64, fromBase64
} from "../src/lib/crypto/vault";

const B = "http://localhost:3000";
let fehler = 0;
const p = (was: string, ok: boolean, zusatz = "") => {
	console.log(`${ok ? "  ok  " : " FEHL "} ${was}${zusatz ? ` — ${zusatz}` : ""}`);
	if (!ok) fehler++;
};
const ruf = async (pfad: string, body: unknown, token?: string) => {
	const r = await fetch(`${B}${pfad}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body)
	});
	return { status: r.status, daten: await r.json().catch(() => null) as Record<string, never> };
};
const ser = (w: { kind: string; salt: Uint8Array; iv: Uint8Array; wrapped: Uint8Array }) =>
	JSON.stringify({ kind: w.kind, salt: toBase64(w.salt), iv: toBase64(w.iv), wrapped: toBase64(w.wrapped) });
const deser = (s: string) => {
	const o = JSON.parse(s);
	return { kind: o.kind, salt: fromBase64(o.salt), iv: fromBase64(o.iv), wrapped: fromBase64(o.wrapped) };
};

console.log("\n=== Konto anlegen, verlieren, zurueckholen ===\n");

// 1. Konto vom Rechner aus anlegen
const angelegt = await ruf("/api/auth/device", { label: "Alter Rechner", invite: "probe-2026" });
p("Konto angelegt", angelegt.status === 200);
const token = angelegt.daten.deviceToken as unknown as string;

// 2. Phrase erzeugen und ablegen - wie die Anwendung es tut
const key = await createVaultKey();
const phrase = createRecoveryPhrase();
const wrapAb = await ruf("/api/wraps", {
	kind: "recovery",
	payload: ser(await wrapWithPhrase(key, phrase)),
	recoveryId: await recoveryLookupId(phrase),
	vaultProof: await vaultProof(key)
}, token);
p("Phrase hinterlegt", wrapAb.status === 200);

// 3. Etwas hochladen
const hoch = await ruf("/api/sync", { records: [{ id: "e1", kind: "entry", bucket: "abc", baseRev: 0, updatedAt: 1, payload: "eA==" }] }, token);
p("Daten hochgeladen", hoch.status === 200);

console.log("\n-- Der Rechner ist jetzt kaputt. In der Hand: 24 Woerter. --\n");

// 4. Kennung rechnen, Verpackung holen
const id = await recoveryLookupId(phrase);
const geholt = await ruf("/api/auth/recover", { recoveryId: id });
p("Verpackung gefunden", geholt.status === 200 && !!geholt.daten.wrap);
p("Dabei KEIN Token", (geholt.daten as Record<string, unknown>).deviceToken === undefined);

// 5. Oeffnen und nachweisen
const zurueck = await unwrapWithPhrase(deser(geholt.daten.wrap as unknown as string), phrase);
p("Verpackung geoeffnet", true);
p("Derselbe Tresorschluessel",
	toBase64(new Uint8Array(await exportVaultKey(zurueck))) === toBase64(new Uint8Array(await exportVaultKey(key))));

const neu = await ruf("/api/auth/recover", { recoveryId: id, proof: await vaultProof(zurueck), label: "Neuer Rechner" });
p("Neues Geraet angemeldet", neu.status === 200);

// 6. Die Daten sind da
const seite = await fetch(`${B}/api/sync?since=0`, { headers: { authorization: `Bearer ${neu.daten.deviceToken}` } });
const inhalt = await seite.json();
p("Die Daten sind noch da", inhalt.records?.length === 1);

// 7. Eine falsche Phrase fuehrt nirgendwohin
const falsch = await ruf("/api/auth/recover", { recoveryId: await recoveryLookupId(createRecoveryPhrase()) });
p("Fremde Phrase findet nichts", falsch.status === 404);

console.log(`\n${fehler === 0 ? "Alles grün." : `${fehler} FEHLER`}\n`);
process.exit(fehler === 0 ? 0 : 1);
