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

const BASE_URL = process.env.TT_BASE_URL ?? "http://127.0.0.1:3000";
const INVITE = process.env.TT_INVITE ?? "probe-2026";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "  ok  " : " FEHL "} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}

async function call(path: string, body: unknown, token?: string) {
	const res = await fetch(`${BASE_URL}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {})
		},
		body: JSON.stringify(body)
	});
	return { status: res.status, data: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

/** Abbrechen mit Bilanz - sonst stirbt das Skript an einem Folgefehler. */
function abort(reason: string): never {
	console.log(`\n Abbruch: ${reason}`);
	console.log(`\n${failures} FEHLER\n`);
	process.exit(1);
}

console.log("\n=== Konto anlegen, verlieren, zurueckholen ===\n");

// 1. Konto vom Rechner aus anlegen
const created = await call("/api/auth/device", { label: "Alter Rechner", invite: INVITE });
check("Konto angelegt", created.status === 200, `Status ${created.status}`);
const token = created.data?.deviceToken;
if (typeof token !== "string") {
	abort(`kein Geraete-Token — Einladung "${INVITE}" gueltig? (TT_INVITE setzen)`);
}

// 2. Phrase erzeugen und ablegen - wie die Anwendung es tut
const key = await createVaultKey();
const phrase = createRecoveryPhrase();
const wrapStored = await call(
	"/api/wraps",
	{
		kind: "recovery",
		payload: await wrapWithPhrase(key, phrase),
		recoveryId: await recoveryLookupId(phrase),
		vaultProof: await vaultProof(key)
	},
	token
);
check("Phrase hinterlegt", wrapStored.status === 200, `Status ${wrapStored.status}`);

// 3. Etwas hochladen
const uploaded = await call(
	"/api/sync",
	{ records: [{ id: "e1", kind: "entry", bucket: "abc", baseRev: 0, updatedAt: 1, payload: "eA==" }] },
	token
);
check("Daten hochgeladen", uploaded.status === 200, `Status ${uploaded.status}`);

console.log("\n-- Der Rechner ist jetzt kaputt. In der Hand: 24 Woerter. --\n");

// 4. Kennung rechnen, Verpackung holen
const recoveryId = await recoveryLookupId(phrase);
const fetched = await call("/api/auth/recover", { recoveryId });
const wrap = fetched.data?.wrap;
check("Verpackung gefunden", fetched.status === 200 && typeof wrap === "string");
check("Dabei KEIN Token", fetched.data?.deviceToken === undefined);
if (typeof wrap !== "string") {
	abort("der Server gibt zu dieser Kennung keine Verpackung heraus");
}

// 5. Oeffnen und nachweisen
let recovered;
try {
	recovered = await unwrapWithPhrase(wrap, phrase);
} catch (e) {
	check("Verpackung geoeffnet", false, e instanceof Error ? e.name : String(e));
	abort("die Verpackung geht mit ihrer eigenen Phrase nicht auf");
}
check("Verpackung geoeffnet", true);
check(
	"Derselbe Vault-Schluessel",
	toBase64(new Uint8Array(await exportVaultKey(recovered))) ===
		toBase64(new Uint8Array(await exportVaultKey(key)))
);

const reconnected = await call("/api/auth/recover", {
	recoveryId,
	proof: await vaultProof(recovered),
	label: "Neuer Rechner"
});
check("Neues Geraet angemeldet", reconnected.status === 200, `Status ${reconnected.status}`);
const newToken = reconnected.data?.deviceToken;
if (typeof newToken !== "string") abort("der Nachweis brachte kein Geraete-Token");

// 6. Die Daten sind da
const page = await fetch(`${BASE_URL}/api/sync?since=0`, {
	headers: { authorization: `Bearer ${newToken}` }
});
const content = (await page.json().catch(() => null)) as { records?: unknown[] } | null;
check("Die Daten sind noch da", content?.records?.length === 1);

// 7. Eine falsche Phrase fuehrt nirgendwohin
const wrongPhrase = await call("/api/auth/recover", {
	recoveryId: await recoveryLookupId(createRecoveryPhrase())
});
check("Fremde Phrase findet nichts", wrongPhrase.status === 404, `Status ${wrongPhrase.status}`);

console.log(`\n${failures === 0 ? "Alles grün." : `${failures} FEHLER`}\n`);
process.exit(failures === 0 ? 0 : 1);
