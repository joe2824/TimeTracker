// Ein Durchstich gegen den laufenden Container.
import { createVaultKey, sealRecord, openRecord, bucketFor } from "../src/lib/crypto/vault";

const BASE_URL = process.env.TT_BASE_URL ?? "http://127.0.0.1:3000";
const TOKEN = process.env.TT_TOKEN;
if (!TOKEN) throw new Error("TT_TOKEN fehlt");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "  ok  " : " FEHL "} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}

async function call(path: string, init: RequestInit = {}, token = TOKEN) {
	const res = await fetch(`${BASE_URL}${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...(init.headers ?? {})
		}
	});
	const text = await res.text();
	let data: unknown = null;
	try {
		data = JSON.parse(text);
	} catch {
		data = text;
	}
	return { status: res.status, data: data as Record<string, never> };
}

// Etwas, das sich in der Datenbank eindeutig wiederfinden liesse, wenn es im
// Klartext dort landete.
const SECRET_NOTE = "Streng-vertraulich-Kundengespraech-Zahnarzt";
const SECRET_ACTIVITY = "Bewerbungsgespraech-Konkurrenz";
const MONTH = "2026-08";

async function main() {
	console.log("\n=== Durchstich gegen den Container ===\n");

	const key = await createVaultKey();

	// ---------- Hochladen ----------
	console.log("-- Daten ablegen --");
	const bucket = await bucketFor(key, MONTH);
	check("Der Zeitraum ist verschleiert", !bucket.includes("2026") && !bucket.includes("08"), bucket);

	const entry = {
		id: "eintrag-1",
		activityId: "akt-1",
		startTs: Date.UTC(2026, 7, 20, 7, 30),
		endTs: Date.UTC(2026, 7, 20, 16, 15),
		note: SECRET_NOTE,
		source: "manual"
	};
	const activity = { id: "akt-1", name: SECRET_ACTIVITY, sortOrder: 1, archived: false };

	const sealedEntry = await sealRecord(key, entry, { id: entry.id, kind: "entry", rev: 1 });
	const sealedActivity = await sealRecord(key, activity, {
		id: activity.id,
		kind: "activity",
		rev: 1
	});

	const uploaded = await call("/api/sync", {
		method: "POST",
		body: JSON.stringify({
			records: [
				{ id: entry.id, kind: "entry", bucket, baseRev: 0, updatedAt: Date.now(), payload: sealedEntry },
				{ id: activity.id, kind: "activity", baseRev: 0, updatedAt: Date.now(), payload: sealedActivity }
			]
		})
	});
	check("Zwei Datensaetze angenommen", uploaded.status === 200 && uploaded.data.accepted?.length === 2);

	// ---------- Wieder herunterladen und oeffnen ----------
	console.log("\n-- Auf einem zweiten Geraet lesen --");
	const downloaded = await call("/api/sync?since=0");
	check("Beide kommen zurueck", downloaded.data.records?.length === 2);

	const records = downloaded.data.records as unknown as { id: string; rev: number; payload: string }[];
	const raw = records.find((r) => r.id === "eintrag-1")!;
	const opened = (await openRecord(key, raw.payload, {
		id: raw.id,
		kind: "entry",
		rev: raw.rev
	})) as typeof entry;
	check("Der Eintrag laesst sich oeffnen", opened.note === SECRET_NOTE);
	check("Die Zeiten stimmen auf die Millisekunde", opened.startTs === entry.startTs);

	// ---------- Was der Server sieht ----------
	console.log("\n-- Was der Betreiber sehen kann --");
	const plaintextFields = JSON.stringify(records.map((r) => ({ ...r, payload: "…" })));
	check("Keine Notiz im Klartext daneben", !plaintextFields.includes(SECRET_NOTE));
	check("Kein Aktivitaetsname im Klartext daneben", !plaintextFields.includes("Bewerbungs"));
	check("Kein Zeitstempel des Eintrags daneben", !plaintextFields.includes(String(entry.startTs)));

	// Anhalten, wenn nur der Bestand aufgebaut werden soll - dann laesst sich in
	// die Datenbankdatei schauen, SOLANGE die Daten noch da sind. Danach zu
	// suchen wuerde nichts beweisen.
	if (process.env.TT_SEED_ONLY) {
		console.log(`
${failures === 0 ? "Bestand liegt." : `${failures} FEHLER`}
`);
		process.exit(failures === 0 ? 0 : 1);
	}

	// ---------- Entkoppeln, Stufe 1: dieses Geraet ----------
	console.log("\n-- Geraet loesen --");
	const secondDevice = process.env.TT_TOKEN2;
	if (secondDevice) {
		const detached = await call("/api/devices", { method: "DELETE", body: "{}" }, secondDevice);
		check("Das zweite Geraet loest sich selbst", detached.status === 200);
		const after = await call("/api/me", {}, secondDevice);
		check("Es hat danach keinen Zugang mehr", after.status === 401);
		const remaining = await call("/api/sync?since=0");
		check("Die Daten sind trotzdem noch da", remaining.data.records?.length === 2);
	}

	// ---------- Entkoppeln, Stufe 2: das ganze Konto ----------
	console.log("\n-- Konto aufloesen --");
	const deleted = await call("/api/me", { method: "DELETE", body: "{}" });
	check("Aufgeloest", deleted.status === 200, JSON.stringify(deleted.data));
	check("Es wurden zwei Datensaetze gemeldet", deleted.data.records === 2);

	const afterwards = await call("/api/me");
	check("Kein Zugang mehr", afterwards.status === 401);
	const sync = await call("/api/sync?since=0");
	check("Kein Abgleich mehr", sync.status === 401);

	console.log(`\n${failures === 0 ? "Alles grün." : `${failures} FEHLER`}\n`);
	process.exit(failures === 0 ? 0 : 1);
}

void main();
