// Ein Durchstich gegen den laufenden Container.
//
// Kein Ersatz fuer die Testsuiten - die pruefen die Regeln. Hier geht es um das,
// was nur in echt schiefgehen kann: das gebaute Abbild, die Datei im Volume, die
// Verschluesselung ueber die Leitung, und die Frage, ob nach dem Entkoppeln
// wirklich nichts mehr da ist.
//
// Bewusst mit dem ECHTEN Krypto-Code des Clients. Etwas Chiffrat-Aehnliches
// hochzuladen wuerde nichts beweisen; die Frage ist ja gerade, ob das, was die
// Anwendung wirklich erzeugt, beim Server unlesbar ankommt.
//
// Aufruf:  npx vite-node scripts/docker-durchstich.ts
import {
	createVaultKey,
	sealRecord,
	openRecord,
	bucketFor,
	toBase64,
	fromBase64
} from "../src/lib/crypto/vault";

const BASIS = process.env.TT_BASIS ?? "http://127.0.0.1:3000";
const TOKEN = process.env.TT_TOKEN;
if (!TOKEN) throw new Error("TT_TOKEN fehlt");

let fehler = 0;
function pruefe(was: string, bedingung: boolean, zusatz = ""): void {
	console.log(`${bedingung ? "  ok  " : " FEHL "} ${was}${zusatz ? ` — ${zusatz}` : ""}`);
	if (!bedingung) fehler++;
}

async function ruf(pfad: string, init: RequestInit = {}, token = TOKEN) {
	const res = await fetch(`${BASIS}${pfad}`, {
		...init,
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...(init.headers ?? {})
		}
	});
	const text = await res.text();
	let daten: unknown = null;
	try {
		daten = JSON.parse(text);
	} catch {
		daten = text;
	}
	return { status: res.status, daten: daten as Record<string, never> };
}

/** Das Chiffrat samt Zufallswert als eine Zeichenkette - wie in engine.ts. */
function packe(s: { iv: Uint8Array; ciphertext: Uint8Array }): string {
	const out = new Uint8Array(s.iv.length + s.ciphertext.length);
	out.set(s.iv);
	out.set(s.ciphertext, s.iv.length);
	return toBase64(out);
}

function entpacke(payload: string) {
	const roh = fromBase64(payload);
	return { iv: roh.slice(0, 12), ciphertext: roh.slice(12) };
}

// Etwas, das sich in der Datenbank eindeutig wiederfinden liesse, wenn es im
// Klartext dort landete.
const GEHEIME_NOTIZ = "Streng-vertraulich-Kundengespraech-Zahnarzt";
const GEHEIME_AKTIVITAET = "Bewerbungsgespraech-Konkurrenz";
const MONAT = "2026-08";

async function main() {
	console.log("\n=== Durchstich gegen den Container ===\n");

	const key = await createVaultKey();

	// ---------- Hochladen ----------
	console.log("-- Daten ablegen --");
	const bucket = await bucketFor(key, MONAT);
	pruefe("Der Zeitraum ist verschleiert", !bucket.includes("2026") && !bucket.includes("08"), bucket);

	const eintrag = {
		id: "eintrag-1",
		activityId: "akt-1",
		startTs: Date.UTC(2026, 7, 20, 7, 30),
		endTs: Date.UTC(2026, 7, 20, 16, 15),
		note: GEHEIME_NOTIZ,
		source: "manual"
	};
	const aktivitaet = { id: "akt-1", name: GEHEIME_AKTIVITAET, sortOrder: 1, archived: false };

	const versiegelt = await sealRecord(key, eintrag, { id: eintrag.id, kind: "entry", rev: 1 });
	const versiegelteAkt = await sealRecord(key, aktivitaet, {
		id: aktivitaet.id,
		kind: "activity",
		rev: 1
	});

	const hoch = await ruf("/api/sync", {
		method: "POST",
		body: JSON.stringify({
			records: [
				{ id: eintrag.id, kind: "entry", bucket, baseRev: 0, updatedAt: Date.now(), payload: packe(versiegelt) },
				{ id: aktivitaet.id, kind: "activity", baseRev: 0, updatedAt: Date.now(), payload: packe(versiegelteAkt) }
			]
		})
	});
	pruefe("Zwei Datensaetze angenommen", hoch.status === 200 && hoch.daten.accepted?.length === 2);

	// ---------- Wieder herunterladen und oeffnen ----------
	console.log("\n-- Auf einem zweiten Geraet lesen --");
	const runter = await ruf("/api/sync?since=0");
	pruefe("Beide kommen zurueck", runter.daten.records?.length === 2);

	const zurueck = runter.daten.records as unknown as { id: string; rev: number; payload: string }[];
	const roh = zurueck.find((r) => r.id === "eintrag-1")!;
	const geoeffnet = (await openRecord(key, entpacke(roh.payload), {
		id: roh.id,
		kind: "entry",
		rev: roh.rev
	})) as typeof eintrag;
	pruefe("Der Eintrag laesst sich oeffnen", geoeffnet.note === GEHEIME_NOTIZ);
	pruefe("Die Zeiten stimmen auf die Millisekunde", geoeffnet.startTs === eintrag.startTs);

	// ---------- Was der Server sieht ----------
	console.log("\n-- Was der Betreiber sehen kann --");
	const klartextFelder = JSON.stringify(zurueck.map((r) => ({ ...r, payload: "…" })));
	pruefe("Keine Notiz im Klartext daneben", !klartextFelder.includes(GEHEIME_NOTIZ));
	pruefe("Kein Aktivitaetsname im Klartext daneben", !klartextFelder.includes("Bewerbungs"));
	pruefe("Kein Zeitstempel des Eintrags daneben", !klartextFelder.includes(String(eintrag.startTs)));

	// Anhalten, wenn nur der Bestand aufgebaut werden soll - dann laesst sich in
	// die Datenbankdatei schauen, SOLANGE die Daten noch da sind. Danach zu
	// suchen wuerde nichts beweisen.
	if (process.env.TT_NUR_ABLEGEN) {
		console.log(`
${fehler === 0 ? "Bestand liegt." : `${fehler} FEHLER`}
`);
		process.exit(fehler === 0 ? 0 : 1);
	}

	// ---------- Entkoppeln, Stufe 1: dieses Geraet ----------
	console.log("\n-- Geraet loesen --");
	const zweitesGeraet = process.env.TT_TOKEN2;
	if (zweitesGeraet) {
		const geloest = await ruf("/api/devices", { method: "DELETE", body: "{}" }, zweitesGeraet);
		pruefe("Das zweite Geraet loest sich selbst", geloest.status === 200);
		const danach = await ruf("/api/me", {}, zweitesGeraet);
		pruefe("Es hat danach keinen Zugang mehr", danach.status === 401);
		const daten = await ruf("/api/sync?since=0");
		pruefe("Die Daten sind trotzdem noch da", daten.daten.records?.length === 2);
	}

	// ---------- Entkoppeln, Stufe 2: das ganze Konto ----------
	console.log("\n-- Konto aufloesen --");
	const auf = await ruf("/api/me", { method: "DELETE", body: "{}" });
	pruefe("Aufgeloest", auf.status === 200, JSON.stringify(auf.daten));
	pruefe("Es wurden zwei Datensaetze gemeldet", auf.daten.records === 2);

	const nachher = await ruf("/api/me");
	pruefe("Kein Zugang mehr", nachher.status === 401);
	const sync = await ruf("/api/sync?since=0");
	pruefe("Kein Abgleich mehr", sync.status === 401);

	console.log(`\n${fehler === 0 ? "Alles grün." : `${fehler} FEHLER`}\n`);
	process.exit(fehler === 0 ? 0 : 1);
}

void main();
