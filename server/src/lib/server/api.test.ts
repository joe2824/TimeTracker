// Durchstich durch die Endpunkte - gegen einen echten Server, ueber echtes HTTP.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db";
import { telemetryPings, users } from "./db/schema";
import { createDevice, createSession, hashSecret, sha256Hex } from "./auth";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

let base: string;
let db: Db;
let dir: string;
let port = 0;
let closeServer: () => Promise<void> = async () => {};

/**
 * Was diese Datei an der Umgebung dreht. Vitest verwendet Worker-Prozesse fuer
 * mehrere Test-Dateien wieder - `process.env` wird dabei NICHT zurueckgesetzt,
 * stehen gelassene Werte kippen also die naechste Datei.
 */
const TOUCHED_ENV = [
	"DB_FILE",
	"DATA_DIR",
	"BACKUP_DIR",
	"ORIGIN",
	"RP_ID",
	"ALLOWED_ORIGINS",
	"ADDRESS_HEADER",
	"SYNC_WAIT_MS",
	"TELEMETRY_KEY"
] as const;
const envBefore = new Map(TOUCHED_ENV.map((k) => [k, process.env[k]] as const));

/** Derselbe Wert, den der Server beim Start aus der Umgebung liest. */
const TELEMETRY_KEY = "test-telemetrie-schluessel";

const ANNA = "user-anna";
const BODO = "user-bodo";
let annaToken = "";
let bodoToken = "";

/** Eine Anfrage im Namen eines Geraets. */
function api(token: string | null, path: string, init: RequestInit = {}) {
	return fetch(`${base}${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...(init.headers ?? {})
		}
	});
}

/** Anfrage aus einer eigenen Adresse - so verbraucht kein Test den Vorrat des naechsten. */
let addressCounter = 0;
function apiFrom(token: string | null, path: string, init: RequestInit = {}) {
	addressCounter++;
	return api(token, path, {
		...init,
		headers: { "x-echte-adresse": `10.0.0.${addressCounter}`, ...(init.headers ?? {}) }
	});
}

// Das Abhol-Geheimnis. Es entsteht auf dem neuen Geraet und bleibt dort; der
// Server sieht nur den Hash. Der Code darf sichtbar sein - das Geheimnis nicht,
// und genau das trennt "abholen duerfen" von "den Code kennen".
const SECRET = "geheim-abholen";
const SECRET_HASH = sha256Hex(SECRET);

/** Schritt 1, mit allem was der Server heute verlangt. */
const startBody = (publicKey: string, label: string, code: string, hash = SECRET_HASH) =>
	JSON.stringify({ publicKey, label, code, claimHash: hash });

/** Schritt 3, mit dem Ausweis. */
const claimBody = (code: string, secret = SECRET) => JSON.stringify({ code, claimSecret: secret });

const rec = (id: string, over: Record<string, unknown> = {}) => ({
	id,
	kind: "entry",
	bucket: "abc123",
	baseRev: 0,
	updatedAt: 1000,
	payload: "Y2hpZmZyYXQ=",
	...over
});

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "tt-api-"));
	const dbFile = join(dir, "test.db");
	process.env.DB_FILE = dbFile;
	// Ohne das schreiben die Backup-Tests nach "./data/backups" - also neben das
	// Repo, aus dem der Lauf gestartet wurde. Der Restore-Endpunkt spielt dort
	// Gefundenes ueber die laufende Datenbank zurueck: ein Rest aus einem frueheren
	// Lauf nimmt den Tests mitten im Durchlauf ihre Sitzungen weg.
	process.env.DATA_DIR = dir;
	process.env.BACKUP_DIR = join(dir, "backups");
	process.env.RP_ID = "localhost";
	// Damit jeder Test seinen eigenen Bremseimer bekommen kann - siehe `apiVon`.
	process.env.ADDRESS_HEADER = "x-echte-adresse";
	// Kurz halten: sonst haengt jeder Wartetest 25 Sekunden.
	process.env.SYNC_WAIT_MS = "800";
	// Ohne den Schluessel gaebe es den Telemetrie-Endpunkt gar nicht.
	process.env.TELEMETRY_KEY = TELEMETRY_KEY;

	db = openDb(dbFile).db;

	// Den gebauten Server starten. Er liest DB_FILE aus der Umgebung und oeffnet
	// dieselbe Datei - beide Seiten sehen damit denselben Bestand.
	// Der GEBAUTE Server, nicht die Quellen: nur so ist geprueft, was spaeter
	// wirklich laeuft - samt Adapter, Kompilat und Aufloesung der Abhaengigkeiten.
	// Erst einen freien Port holen, dann ORIGIN setzen: ein fest verdrahteter Port
	// kollidiert mit einem zweiten Lauf, der ihn noch nicht losgelassen hat. Der
	// gebaute Server liest ORIGIN beim Import - er darf also erst danach geladen
	// werden, deshalb der nachgereichte Handler.
	const { createServer } = await import("node:http");
	let handle: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
	const http = createServer((req, res) => handle?.(req, res));
	await new Promise<void>((r) => http.listen(0, r));
	const address = http.address();
	port = typeof address === "object" && address !== null ? address.port : 0;
	base = `http://localhost:${port}`;
	process.env.ORIGIN = base;
	process.env.ALLOWED_ORIGINS = base;

	const handlerPath = new URL("../../../build/handler.js", import.meta.url).href;
	const built = (await import(/* @vite-ignore */ handlerPath)) as {
		handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
	};
	handle = (req, res) => built.handler(req, res, () => {});
	closeServer = () => new Promise<void>((r) => http.close(() => r()));
});

afterAll(async () => {
	// Abwarten, nicht nur anstossen: ein noch offener Zuhoerer haelt den Port und
	// die naechste Datei im selben Prozess faende ihn belegt.
	await closeServer();
	for (const [k, v] of envBefore) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* Aufraeumen darf den Lauf nicht kippen */
	}
});

beforeEach(() => {
	db.delete(users).run();
	db.insert(users).values({ id: ANNA, displayName: "Anna", createdAt: 1, seqCounter: 0 }).run();
	db.insert(users).values({ id: BODO, displayName: "Bodo", createdAt: 1, seqCounter: 0 }).run();
	annaToken = createDevice(db, ANNA, "Annas Rechner").token;
	bodoToken = createDevice(db, BODO, "Bodos Rechner").token;
});

describe("Zugang", () => {
	it("weist eine Anfrage ohne Ausweis ab", async () => {
		expect((await api(null, "/api/sync")).status).toBe(401);
		expect((await api(null, "/api/me")).status).toBe(401);
		expect((await api(null, "/api/wraps")).status).toBe(401);
	});

	it("weist ein erfundenes Token ab", async () => {
		expect((await api("ausgedacht", "/api/sync")).status).toBe(401);
	});

	it("laesst ein gueltiges Geraete-Token durch", async () => {
		const r = await api(annaToken, "/api/me");
		expect(r.status).toBe(200);
		expect((await r.json()).displayName).toBe("Anna");
	});

	it("laesst den Anzeigenamen per PATCH /api/me aktualisieren", async () => {
		const r = await api(annaToken, "/api/me", {
			method: "PATCH",
			body: JSON.stringify({ displayName: "Anna Neu" })
		});
		expect(r.status).toBe(200);
		expect((await r.json()).displayName).toBe("Anna Neu");

		const me = await (await api(annaToken, "/api/me")).json();
		expect(me.displayName).toBe("Anna Neu");
	});

	it("weist ein widerrufenes Geraet ab", async () => {
		const me = await (await api(annaToken, "/api/me")).json();
		const deviceId = me.devices[0].id;
		const gone = await api(annaToken, "/api/devices", {
			method: "DELETE",
			body: JSON.stringify({ deviceId })
		});
		expect(gone.status).toBe(200);
		expect((await api(annaToken, "/api/sync")).status).toBe(401);
	});

	it("laesst kein fremdes Geraet widerrufen", async () => {
		const me = await (await api(annaToken, "/api/me")).json();
		const r = await api(bodoToken, "/api/devices", {
			method: "DELETE",
			body: JSON.stringify({ deviceId: me.devices[0].id })
		});
		expect(r.status).toBe(404);
		// Annas Geraet funktioniert weiterhin.
		expect((await api(annaToken, "/api/sync")).status).toBe(200);
	});

	it("die Gesundheitsanzeige braucht keine Anmeldung", async () => {
		const r = await api(null, "/api/health");
		expect(r.status).toBe(200);
		expect((await r.json()).ok).toBe(true);
	});
});

describe("Abgleich ueber HTTP", () => {
	it("legt ab und holt wieder", async () => {
		const push = await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("e1"), rec("e2")] })
		});
		expect(push.status).toBe(200);
		expect((await push.json()).accepted).toHaveLength(2);

		const pull = await (await api(annaToken, "/api/sync?since=0")).json();
		expect(pull.records.map((r: { id: string }) => r.id)).toEqual(["e1", "e2"]);
	});

	it("meldet einen Konflikt statt zu ueberschreiben", async () => {
		await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("e1")] })
		});
		const second = await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("e1", { baseRev: 0 })] })
		});
		const body = await second.json();
		expect(body.accepted).toEqual([]);
		expect(body.conflicts).toHaveLength(1);
	});

	it("weist einen masslosen Stapel ab", async () => {
		const tooMany = Array.from({ length: 501 }, (_, i) => rec(`e${i}`));
		const r = await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: tooMany })
		});
		expect(r.status).toBe(413);
	});

	it("weist einen Rumpf ohne records ab", async () => {
		const r = await api(annaToken, "/api/sync", { method: "POST", body: JSON.stringify({}) });
		expect(r.status).toBe(400);
	});

	it("weist einen unsinnigen Stand ab", async () => {
		expect((await api(annaToken, "/api/sync?since=-5")).status).toBe(400);
		expect((await api(annaToken, "/api/sync?since=abc")).status).toBe(400);
	});
});

describe("Mandantentrennung ueber HTTP", () => {
	it("Bodo sieht nichts von Anna", async () => {
		await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("geheim")] })
		});
		const bodo = await (await api(bodoToken, "/api/sync?since=0")).json();
		expect(bodo.records).toEqual([]);
	});

	it("Bodo kann Annas Datensatz nicht ueberschreiben", async () => {
		await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("e1", { payload: "YW5uYQ==" })] })
		});
		await api(bodoToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("e1", { payload: "Ym9kbw==" })] })
		});
		const anna = await (await api(annaToken, "/api/sync?since=0")).json();
		expect(anna.records[0].payload).toBe("YW5uYQ==");
	});

	it("Bodo sieht Annas Verpackungen nicht", async () => {
		await api(annaToken, "/api/wraps", {
			method: "POST",
			body: JSON.stringify({ kind: "recovery", payload: "dmVycGFja3VuZw==" })
		});
		expect((await (await api(bodoToken, "/api/wraps")).json()).wraps).toEqual([]);
		expect((await (await api(annaToken, "/api/wraps")).json()).wraps).toHaveLength(1);
	});

	it("Bodo sieht Annas Geraete nicht", async () => {
		const bodo = await (await api(bodoToken, "/api/me")).json();
		expect(bodo.devices.map((d: { label: string }) => d.label)).toEqual(["Bodos Rechner"]);
	});
});

describe("Verpackungen", () => {
	it("ersetzt die Phrasen-Verpackung, statt eine zweite anzulegen", async () => {
		// Sonst gaebe es zwei gueltige Wege zum selben Schluessel - eine stille
		// Hintertuer fuer eine Phrase, die jemand fuer ersetzt haelt.
		for (const p of ["ZXJzdGU=", "enZlaXRl"]) {
			await api(annaToken, "/api/wraps", {
				method: "POST",
				body: JSON.stringify({ kind: "recovery", payload: p })
			});
		}
		const wraps = (await (await api(annaToken, "/api/wraps")).json()).wraps;
		expect(wraps).toHaveLength(1);
		expect(wraps[0].payload).toBe("enZlaXRl");
	});

	it("meldet einen Passkey mit Verpackung als solchen", async () => {
		db.$client
			.prepare(
				"INSERT INTO credentials (id, user_id, public_key, counter, has_prf, label, created_at) VALUES (?,?,?,0,0,?,?)"
			)
			.run("annas-schluessel", ANNA, Buffer.from([1, 2, 3]), null, Date.now());

		await api(annaToken, "/api/wraps", {
			method: "POST",
			body: JSON.stringify({
				kind: "passkey",
				payload: "dmVycGFja3Q=",
				credentialId: "annas-schluessel"
			})
		});

		const { passkeys } = await (await api(annaToken, "/api/passkeys")).json();
		expect(passkeys[0].hasWrap).toBe(true);
	});

	it("meldet einen Passkey ohne Verpackung als solchen", async () => {
		db.$client
			.prepare(
				"INSERT INTO credentials (id, user_id, public_key, counter, has_prf, label, created_at) VALUES (?,?,?,0,1,?,?)"
			)
			.run("annas-schluessel", ANNA, Buffer.from([1, 2, 3]), null, Date.now());

		const { passkeys } = await (await api(annaToken, "/api/passkeys")).json();
		expect(passkeys[0].hasWrap).toBe(false);
	});

	it("weist eine unbekannte Art ab", async () => {
		const r = await api(annaToken, "/api/wraps", {
			method: "POST",
			body: JSON.stringify({ kind: "hintertuer", payload: "eA==" })
		});
		expect(r.status).toBe(400);
	});
});

describe("Kopplung", () => {
	// Der Code ist auf dem GERAET der Abdruck des oeffentlichen Schluessels
	// (src/lib/crypto/vault.ts). Hier steht ein fester, wohlgeformter Wert: der
	// Server rechnet die Bindung bewusst nicht nach - er ist in diesem Angriff
	// selbst der Angreifer, und seine eigene Pruefung bewiese niemandem etwas.
	// Was er prueft, ist die Form. Nachgerechnet wird drueben, in vault.test.ts.
	const CODE = "ABCDEFGHJKLM";
	const CODE2 = "NPQRSTUVWXYZ";

	it("laeuft vom Code bis zum Token durch", async () => {
		// Schritt 1 auf dem neuen Geraet - ohne Anmeldung.
		const start = await (
			await api(null, "/api/pair/start", {
				method: "POST",
				body: startBody("b2VmZmVudGxpY2g=", "Handy", CODE)
			})
		).json();
		expect(start.code).toBe(CODE);

		// Noch nichts abzuholen.
		const early = await (
			await api(null, "/api/pair/claim", {
				method: "POST",
				body: claimBody(start.code)
			})
		).json();
		expect(early.pending).toBe(true);

		// Schritt 2 auf dem entsperrten Geraet.
		const seen = await (await api(annaToken, `/api/pair/approve?code=${start.code}`)).json();
		expect(seen.publicKey).toBe("b2VmZmVudGxpY2g=");
		const ok = await api(annaToken, "/api/pair/approve", {
			method: "POST",
			body: JSON.stringify({ code: start.code, wrappedKey: "cGFrZXQ=" })
		});
		expect(ok.status).toBe(200);

		// Schritt 3 zurueck auf dem neuen Geraet.
		const claim = await (
			await api(null, "/api/pair/claim", {
				method: "POST",
				body: claimBody(start.code)
			})
		).json();
		expect(claim.pending).toBe(false);
		expect(claim.wrappedKey).toBe("cGFrZXQ=");
		expect(claim.userId).toBe(ANNA);

		// Das frische Token gehoert zu Annas Konto.
		expect((await (await api(claim.deviceToken, "/api/me")).json()).userId).toBe(ANNA);
	});

	it("gibt dasselbe Paket kein zweites Mal heraus", async () => {
		const start = await (
			await api(null, "/api/pair/start", {
				method: "POST",
				body: startBody("cHVi", "Handy", CODE)
			})
		).json();
		await api(annaToken, "/api/pair/approve", {
			method: "POST",
			body: JSON.stringify({ code: start.code, wrappedKey: "cGFrZXQ=" })
		});
		const body = claimBody(start.code);
		expect((await (await api(null, "/api/pair/claim", { method: "POST", body })).json()).pending).toBe(false);
		expect((await api(null, "/api/pair/claim", { method: "POST", body })).status).toBe(404);
	});

	it("laesst denselben Code nicht zweimal bestaetigen", async () => {
		const start = await (
			await api(null, "/api/pair/start", {
				method: "POST",
				body: startBody("cHVi", "Handy", CODE2)
			})
		).json();
		const body = JSON.stringify({ code: start.code, wrappedKey: "cGFrZXQ=" });
		expect((await api(annaToken, "/api/pair/approve", { method: "POST", body })).status).toBe(200);
		expect((await api(bodoToken, "/api/pair/approve", { method: "POST", body })).status).toBe(409);
	});

	// ---- Der Code allein reicht nicht ----
	//
	// Der Kopplungscode ist der Abdruck des Geraeteschluessels. Er MUSS sichtbar
	// sein, sonst kann ihn niemand vergleichen - er steht am Bildschirm und wird
	// abgetippt. Als Ausweis beim Abholen taugt er damit nicht: wer ihn mitliest,
	// bekaeme sonst das Geraete-Token. Den Tresor oeffnet er damit zwar nicht,
	// aber er haette Zugang zu den versiegelten Datensaetzen - und der echte
	// Vorgang waere abgeraeumt, weil das Abholen die Zeile loescht.

	// apiVon statt api: jeder dieser Tests beginnt eigene Kopplungen, und der
	// Bremseimer fuer /api/pair/start haengt an der Adresse. Ueber api() waere der
	// Vorrat der uebrigen Tests aufgebraucht.
	it("gibt ohne Abhol-Geheimnis nichts heraus", async () => {
		const code = "AAAABBBBCCCC";
		await apiFrom(null, "/api/pair/start", { method: "POST", body: startBody("cHVi", "Handy", code) });
		await api(annaToken, "/api/pair/approve", {
			method: "POST",
			body: JSON.stringify({ code, wrappedKey: "cGFrZXQ=" })
		});

		// Nur der Code - wie ihn jemand vom Bildschirm ablesen koennte.
		const without = await apiFrom(null, "/api/pair/claim", {
			method: "POST",
			body: JSON.stringify({ code })
		});
		expect(without.status).toBe(404);

		// Und das Paket liegt noch da: der Fehlgriff hat den Vorgang nicht verbraucht.
		const real = await (
			await apiFrom(null, "/api/pair/claim", { method: "POST", body: claimBody(code) })
		).json();
		expect(real.pending).toBe(false);
		expect(real.wrappedKey).toBe("cGFrZXQ=");
	});

	it("weist ein falsches Abhol-Geheimnis wie einen unbekannten Code ab", async () => {
		// 404, nicht 403: eine eigene Antwort verriete, dass es diesen Vorgang
		// gibt. So sieht Raten aus wie Raten - und die Bremse zaehlt es als
		// Fehlgriff (siehe hooks.server.ts).
		const code = "DDDDEEEEFFFF";
		await apiFrom(null, "/api/pair/start", { method: "POST", body: startBody("cHVi", "Handy", code) });
		const wrong = await apiFrom(null, "/api/pair/claim", {
			method: "POST",
			body: claimBody(code, "danebengeraten")
		});
		expect(wrong.status).toBe(404);
	});

	it("laesst kein fremdes Abhol-Geheimnis nachschieben", async () => {
		// Der oeffentliche Schluessel ist ueber /api/pair/approve abfragbar. Wer ihn
		// samt Code hat, duerfte sonst mit einem eigenen Geheimnis noch einmal
		// starten und dem echten Geraet das Token wegnehmen.
		const code = "GGGGHHHHJJJJ";
		await apiFrom(null, "/api/pair/start", { method: "POST", body: startBody("cHVi", "Handy", code) });

		const foreign = await apiFrom(null, "/api/pair/start", {
			method: "POST",
			body: startBody("cHVi", "Handy", code, sha256Hex("meins"))
		});
		expect(foreign.status).toBe(409);

		// Das echte Geheimnis gilt weiterhin.
		await api(annaToken, "/api/pair/approve", {
			method: "POST",
			body: JSON.stringify({ code, wrappedKey: "cGFrZXQ=" })
		});
		const real = await (
			await apiFrom(null, "/api/pair/claim", { method: "POST", body: claimBody(code) })
		).json();
		expect(real.pending).toBe(false);
	});

	it("rechnet denselben Hash wie das Geraet", () => {
		// Angenagelt, und derselbe Wert steht in src/lib/crypto/vault.test.ts.
		// Rechnen Server und Geraet verschieden, koppelt gar nichts mehr - und
		// zwar still, weil der Server dann einfach 404 antwortet.
		expect(SECRET_HASH).toBe("38493643ffb2d864afda079804427ffd9224181468ba3dd5fcd018863d169da2");
	});

	it("beginnt keine Kopplung ohne Abhol-Geheimnis", async () => {
		// Aeltere Fassungen der Anwendung schicken keinen mit. Der Vorgang wird
		// abgewiesen, statt still auf die schwaechere Regel zurueckzufallen.
		const r = await apiFrom(null, "/api/pair/start", {
			method: "POST",
			body: JSON.stringify({ publicKey: "cHVi", label: "Alt", code: "KKKKLLLLMMMM" })
		});
		expect(r.status).toBe(400);
	});

	it("weist einen unbekannten Code ab", async () => {
		expect((await api(annaToken, "/api/pair/approve?code=XXXXXXXXXXXX")).status).toBe(404);
	});

	it("verlangt fuer das Bestaetigen eine Anmeldung", async () => {
		const r = await api(null, "/api/pair/approve", {
			method: "POST",
			body: JSON.stringify({ code: "XXXXXXXXXXXX", wrappedKey: "eA==" })
		});
		expect(r.status).toBe(401);
	});

	it("laesst einen laufenden Vorgang nicht von aussen ueberschreiben", async () => {
		// Ein unangemeldeter Aufruf darf einem fremden, laufenden Vorgang nicht
		// dazwischenfahren - sonst laege unter einem Code, den jemand gerade
		// abliest, ploetzlich ein anderer Schluessel.
		const code = "MMMMNNNNPPPP";
		await api(null, "/api/pair/start", {
			method: "POST",
			body: startBody("ZWNodA==", "Echt", code)
		});

		const foreign = await api(null, "/api/pair/start", {
			method: "POST",
			body: startBody("ZmFsc2No", "Untergeschoben", code)
		});
		expect(foreign.status).toBe(409);

		// Und der echte Schluessel steht noch da.
		const seen = await (await api(annaToken, `/api/pair/approve?code=${code}`)).json();
		expect(seen.publicKey).toBe("ZWNodA==");
	});

	it("nimmt denselben Vorgang noch einmal an, ohne das Paket zu verlieren", async () => {
		// Derselbe Schluessel ergibt denselben Code: ein zweiter Anlauf desselben
		// Geraets landet zwangslaeufig auf demselben Vorgang.
		const code = "RRRRSSSSTTTT";
		const body = startBody("d2llZGVy", "Handy", code);
		expect((await api(null, "/api/pair/start", { method: "POST", body })).status).toBe(200);
		await api(annaToken, "/api/pair/approve", {
			method: "POST",
			body: JSON.stringify({ code, wrappedKey: "cGFrZXQ=" })
		});
		expect((await api(null, "/api/pair/start", { method: "POST", body })).status).toBe(200);

		// Das hinterlegte Paket hat den zweiten Anlauf ueberlebt.
		const claim = await (
			await api(null, "/api/pair/claim", { method: "POST", body: claimBody(code) })
		).json();
		expect(claim.pending).toBe(false);
		expect(claim.wrappedKey).toBe("cGFrZXQ=");
	});
});

describe("Ereigniskanal", () => {
	it("meldet den aktuellen Stand und weckt bei einer Aenderung", async () => {
		const ac = new AbortController();
		const answer = await fetch(`${base}/api/sync/stream`, {
			headers: { authorization: `Bearer ${annaToken}` },
			signal: ac.signal
		});
		expect(answer.headers.get("content-type")).toContain("text/event-stream");

		const reader = answer.body!.getReader();
		const dec = new TextDecoder();
		const read = async () => dec.decode((await reader.read()).value);

		expect(await read()).toContain("event: hello");

		// Ein zweites Geraet schreibt - der Kanal muss davon erzaehlen.
		await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("e1")] })
		});
		const msg = await read();
		expect(msg).toContain("event: change");
		expect(msg).toContain('"seq":1');

		ac.abort();
		await reader.cancel().catch(() => {});
	});

	it("erzaehlt nicht von den Aenderungen eines fremden Kontos", async () => {
		const ac = new AbortController();
		const answer = await fetch(`${base}/api/sync/stream`, {
			headers: { authorization: `Bearer ${bodoToken}` },
			signal: ac.signal
		});
		const reader = answer.body!.getReader();
		const dec = new TextDecoder();
		expect(dec.decode((await reader.read()).value)).toContain("event: hello");

		await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("annas")] })
		});

		// Kein Weckruf innerhalb einer kurzen Frist. Ohne die Frist waere der Test
		// eine Wette darauf, dass nichts kommt, bevor er zu Ende ist.
		const race = await Promise.race([
			reader.read().then(() => "wach"),
			new Promise((r) => setTimeout(() => r("still"), 300))
		]);
		expect(race).toBe("still");

		ac.abort();
		await reader.cancel().catch(() => {});
	});

	it("verlangt eine Anmeldung", async () => {
		expect((await fetch(`${base}/api/sync/stream`)).status).toBe(401);
	});
});

describe("Warteschleife statt Ereigniskanal", () => {
	it("kommt sofort zurueck, wenn der Server schon weiter ist", async () => {
		await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("e1")] })
		});

		const started = Date.now();
		const answer = await api(annaToken, "/api/sync/wait?since=0");
		const payloadData = await answer.json();

		expect(answer.status).toBe(200);
		expect(payloadData.changed).toBe(true);
		expect(payloadData.seq).toBeGreaterThan(0);
		// Nicht gewartet: sonst verpasst ein Client jede Aenderung, die zwischen
		// seinem Abgleich und dieser Anfrage passiert ist.
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("haelt offen und antwortet, sobald geschrieben wird", async () => {
		const knownSeq = await (await api(annaToken, "/api/sync/wait?since=0")).json().catch(() => null);
		const sinceTs = knownSeq?.seq ?? 0;

		const waiting = api(annaToken, `/api/sync/wait?since=${sinceTs}`);
		// Erst schreiben, wenn die Anfrage wirklich haengt - sonst faengt sie der
		// Schnellweg oben ab und der Test prueft nichts.
		await new Promise((r) => setTimeout(r, 150));
		await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("e2")] })
		});

		const payloadData = await (await waiting).json();
		expect(payloadData.changed).toBe(true);
		expect(payloadData.seq).toBeGreaterThan(sinceTs);
	});

	it("weckt nicht bei der Aenderung eines fremden Kontos", async () => {
		const sinceTs = (await (await api(bodoToken, "/api/sync/wait?since=0")).json()).seq;
		const waiting = api(bodoToken, `/api/sync/wait?since=${sinceTs}`);
		await new Promise((r) => setTimeout(r, 150));
		await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("annas")] })
		});

		// Sie kommt nach Ablauf der Wartezeit zurueck - aber ohne Aenderung.
		expect((await (await waiting).json()).changed).toBe(false);
	});

	it("verlangt eine Anmeldung", async () => {
		expect((await fetch(`${base}/api/sync/wait?since=0`)).status).toBe(401);
	});
});

describe("Konto aufloesen", () => {
	/** Was Anna alles beim Server hat, bevor sie es aufloest. */
	async function fillAnna() {
		await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("e1"), rec("e2"), rec("e3")] })
		});
		await api(annaToken, "/api/wraps", {
			method: "POST",
			body: JSON.stringify({ kind: "recovery", payload: "verpackt" })
		});
	}

	it("verlangt eine Anmeldung", async () => {
		const res = await api(null, "/api/me", { method: "DELETE", body: "{}" });
		expect(res.status).toBe(401);
	});

	it("laesst eine blosse Sitzung nicht genuegen", async () => {
		// Der Kern der Sache: ein Cookie faehrt bei jeder Anfrage automatisch mit.
		// Es beweist, dass irgendwann jemand angemeldet war - nicht, dass gerade
		// jetzt jemand zustimmt. Ohne frische Bestaetigung passiert nichts.
		const session = createSession(db, ANNA);
		const res = await fetch(`${base}/api/me`, {
			method: "DELETE",
			headers: { "content-type": "application/json", cookie: `tt_session=${session}` },
			body: "{}"
		});
		expect(res.status).toBe(400);

		// Und das Konto steht noch.
		expect((await api(annaToken, "/api/me")).status).toBe(200);
	});

	it("weist eine erfundene Bestaetigung ab", async () => {
		const session = createSession(db, ANNA);
		const start = await fetch(`${base}/api/me/confirm`, {
			method: "POST",
			headers: { cookie: `tt_session=${session}` }
		});
		// Anna hat keinen Passkey (die Konten entstehen hier direkt in der
		// Datenbank) - dann gibt es auch nichts zu bestaetigen, und der Weg ueber
		// die Sitzung ist verschlossen. Genau richtig: einen Passkey vorzutaeuschen
		// darf nicht gehen.
		expect(start.status).toBe(409);

		// Eine zusammengereimte Antwort wird ebenfalls nicht angenommen.
		const res = await fetch(`${base}/api/me`, {
			method: "DELETE",
			headers: { "content-type": "application/json", cookie: `tt_session=${session}` },
			body: JSON.stringify({ challengeId: "ausgedacht", response: { id: "x" } })
		});
		expect(res.status).toBe(400);
		expect((await api(annaToken, "/api/me")).status).toBe(200);
	});

	it("verlangt fuer die Bestaetigung eine Anmeldung", async () => {
		expect((await api(null, "/api/me/confirm", { method: "POST" })).status).toBe(401);
	});

	it("nimmt das Geraete-Token als Nachweis - es ist der Zugangscode selbst", async () => {
		// 256 Bit Zufall, genau einmal bei der Kopplung uebertragen, in keinem
		// Browser-Kontext, faehrt nirgends automatisch mit. Wer es hat, hat das
		// gekoppelte Geraet - und damit ohnehin den Tresorschluessel.
		const res = await api(annaToken, "/api/me", { method: "DELETE", body: "{}" });
		expect(res.status).toBe(200);
	});

	it("nimmt ein widerrufenes Token nicht", async () => {
		await api(annaToken, "/api/devices", { method: "DELETE", body: "{}" });
		const res = await api(annaToken, "/api/me", { method: "DELETE", body: "{}" });
		expect(res.status).toBe(401);
		expect((await api(bodoToken, "/api/me")).status).toBe(200);
	});

	it("entfernt alles, was zum Konto gehoert", async () => {
		await fillAnna();

		const res = await api(annaToken, "/api/me", { method: "DELETE", body: "{}" });
		expect(res.status).toBe(200);
		const summary = await res.json();
		expect(summary).toMatchObject({ ok: true, records: 3, wraps: 1, devices: 1 });

		// Nicht der Meldung glauben, sondern nachsehen: in der Datenbank selbst
		// darf zu diesem Konto keine einzige Zeile mehr stehen.
		const countRows = (table: string) =>
			(
				db.$client.prepare(`SELECT count(*) AS n FROM ${table} WHERE user_id = ?`).get(ANNA) as {
					n: number;
				}
			).n;
		expect(countRows("records")).toBe(0);
		expect(countRows("key_wraps")).toBe(0);
		expect(countRows("devices")).toBe(0);
		expect(countRows("credentials")).toBe(0);
		expect(countRows("sessions")).toBe(0);
		expect(
			(db.$client.prepare(`SELECT count(*) AS n FROM users WHERE id = ?`).get(ANNA) as { n: number })
				.n
		).toBe(0);
	});

	it("laesst das Konto daneben unangetastet", async () => {
		await fillAnna();
		await api(bodoToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("b1"), rec("b2")] })
		});

		await api(annaToken, "/api/me", { method: "DELETE", body: "{}" });

		// Bodo merkt von alldem nichts. Das ist der Punkt, an dem sich zeigt, ob
		// die Loeschung wirklich auf ein Konto eingeschraenkt war.
		const pageNo = await (await api(bodoToken, "/api/sync?since=0")).json();
		expect(pageNo.records.map((r: { id: string }) => r.id).sort()).toEqual(["b1", "b2"]);
		expect((await api(bodoToken, "/api/me")).status).toBe(200);
	});

	it("der Zugang gilt danach nicht mehr", async () => {
		await api(annaToken, "/api/me", { method: "DELETE", body: "{}" });

		// Das Token ist nicht nur widerrufen - das Geraet dahinter gibt es nicht
		// mehr. Beides muss dasselbe ergeben: keinen Zugang.
		expect((await api(annaToken, "/api/me")).status).toBe(401);
		expect((await api(annaToken, "/api/sync?since=0")).status).toBe(401);
		const push = await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("neu")] })
		});
		expect(push.status).toBe(401);
	});

	it("meldet einen Konflikt gegen Fassung 0 fuer einen Datensatz, den es nicht gibt", async () => {
		// Die Lage nach einem Aufloesen: das Geraet haelt noch Fassungsnummern von
		// einem Konto, das es beim Server nicht mehr gibt. Der Server muss das als
		// Konflikt gegen 0 melden - daran erkennt der Client, dass er neu anfangen
		// muss statt zusammenzufuehren.
		const res = await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("e1", { baseRev: 7 })] })
		});
		const answer = await res.json();
		expect(answer.accepted).toHaveLength(0);
		expect(answer.conflicts).toHaveLength(1);
		expect(answer.conflicts[0].current.rev).toBe(0);
	});
});

describe("Geraet loesen", () => {
	it("loest ohne Angabe das aufrufende Geraet selbst", async () => {
		// Der Weg beim Entkoppeln: das Geraet kennt seine eigene Kennung beim
		// Server nicht - bei der Kopplung bekommt es ein Token, keine ID.
		const res = await api(annaToken, "/api/devices", { method: "DELETE", body: "{}" });
		expect(res.status).toBe(200);
		expect((await api(annaToken, "/api/me")).status).toBe(401);
	});

	it("laesst das Konto und seine Daten dabei stehen", async () => {
		await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("e1")] })
		});
		const secondD = createDevice(db, ANNA, "Annas Handy").token;

		await api(annaToken, "/api/devices", { method: "DELETE", body: "{}" });

		// Das andere Geraet arbeitet weiter, und die Daten sind vollstaendig da.
		// Genau hierin unterscheidet sich "Geraet loesen" vom Aufloesen.
		const pageNo = await (await api(secondD, "/api/sync?since=0")).json();
		expect(pageNo.records).toHaveLength(1);
	});

	it("gibt eine Sitzung ohne Geraet nicht als Geraet aus", async () => {
		// Ohne Token und ohne Angabe gibt es nichts zu loesen. Waere das ein
		// stiller Erfolg, haette der Aufrufer den Eindruck, etwas sei passiert.
		const res = await api(null, "/api/devices", { method: "DELETE", body: "{}" });
		expect(res.status).toBe(401);
	});
});

// ACHTUNG, Reihenfolge: dieser Block muss VOR den Tests stehen, die die Bremse
// leerlaufen lassen. Ihr Zustand lebt im Serverprozess und laesst sich von aussen
// nicht zuruecksetzen - ein leergeratener Eimer wuerde hier sonst als Fehler
// erscheinen, obwohl nichts kaputt ist.
describe("Warten beim Koppeln", () => {
	it("bremst das Warten nicht aus", async () => {
		// Die Oberflaeche fragt im Zwei-Sekunden-Takt nach, ob jemand bestaetigt
		// hat, und ein Kopplungscode gilt zehn Minuten. Das sind bis zu
		// dreihundert Anfragen fuer einen voellig normalen Vorgang.
		const code = "WWWWXXXXYYYY";
		const started = await api(null, "/api/pair/start", {
			method: "POST",
			body: startBody("AAAA", "Wartendes Gerät", code)
		});
		expect(started.status).toBe(200);

		for (let i = 0; i < 60; i++) {
			const res = await api(null, "/api/pair/claim", {
				method: "POST",
				body: claimBody(code)
			});
			expect(res.status, `Anfrage ${i + 1}`).toBe(200);
			expect((await res.json()).pending).toBe(true);
		}
	});

	it("bremst das Raten weiterhin", async () => {
		// Ein Fehlgriff ist ein Fehlgriff - egal wie oft jemand es versucht.
		let throttled = false;
		for (let i = 0; i < 40; i++) {
			const res = await api(null, "/api/pair/claim", {
				method: "POST",
				body: JSON.stringify({ code: `RATEVERSUCH${i}` })
			});
			if (res.status === 429) {
				throttled = true;
				break;
			}
		}
		expect(throttled).toBe(true);
	});
});

describe("Bremse und Herkunft", () => {
	it("bremst das Abfragen eines Kopplungscodes", async () => {
		// Der Endpunkt ist ohne Anmeldung erreichbar und gibt bei einem Treffer ein
		// Geraete-Token heraus. Der Code hat vierzig Bit - rechnerisch nicht zu
		// raten. Aber "rechnerisch nicht" ist eine Aussage ueber einen Angreifer,
		// der ehrlich rechnet, nicht ueber einen, der oft fragt.
		let throttled = false;
		for (let i = 0; i < 40; i++) {
			const res = await api(null, "/api/pair/claim", {
				method: "POST",
				body: JSON.stringify({ code: `RATEN${i}` })
			});
			if (res.status === 429) {
				throttled = true;
				expect(res.headers.get("retry-after")).toBeTruthy();
				break;
			}
		}
		expect(throttled).toBe(true);
	});

	it("weist eine schreibende Anfrage von fremder Herkunft ab", async () => {
		const session = createSession(db, ANNA);
		const res = await fetch(`${base}/api/sync`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://boeswillig.example",
				cookie: `tt_session=${session}`
			},
			body: JSON.stringify({ records: [rec("x")] })
		});
		expect(res.status).toBe(403);
	});

	it("laesst die eigene Herkunft durch", async () => {
		const session = createSession(db, ANNA);
		const res = await fetch(`${base}/api/sync`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: base,
				cookie: `tt_session=${session}`
			},
			body: JSON.stringify({ records: [rec("x")] })
		});
		expect(res.status).toBe(200);
	});

	it("laesst ein Geraete-Token ohne Herkunftspruefung durch", async () => {
		// Die Desktop-Anwendung hat eine Herkunft, die kein Server sinnvoll
		// erlauben kann. Sie weist sich stattdessen mit dem Token aus - und das
		// faehrt nirgends automatisch mit.
		const res = await api(annaToken, "/api/sync", {
			method: "POST",
			headers: { origin: "tauri://localhost" },
			body: JSON.stringify({ records: [rec("x")] })
		});
		expect(res.status).toBe(200);
	});
});

describe("Ohne Reverse-Proxy davor", () => {
	it("bremst auch dann, wenn die Adresskopfzeile fehlt", async () => {
		// ADDRESS_HEADER ist in der Compose-Datei gesetzt, weil im Betrieb ein
		// Proxy davorsteht. Spricht jemand den Container direkt an - beim ersten
		// Ausprobieren also fast immer - fehlt die Kopfzeile, und
		// getClientAddress() WIRFT. Ungefangen antwortet dann jeder gebremste
		// Endpunkt mit einem Serverfehler statt zu arbeiten.
		process.env.ADDRESS_HEADER = "x-forwarded-for";
		const res = await api(null, "/api/auth/register/start", {
			method: "POST",
			body: JSON.stringify({ displayName: "Wer auch immer" })
		});
		// Was genau herauskommt, haengt an den Einladungscodes - nur ein
		// Serverfehler darf es nicht sein.
		expect(res.status).not.toBe(500);
	});
});

describe("Herkunft unter verschiedenen Namen", () => {
	// Derselbe Container ist ueber localhost, 127.0.0.1, den Rechnernamen und die
	// Adresse im Heimnetz erreichbar. Unter jedem dieser Namen ist eine Anfrage
	// von der eigenen Seite dieselbe Seite - und muss durchkommen. Sonst kann
	// sich niemand registrieren, der die Adresse anders tippt als ORIGIN.
	it("laesst die eigene Adresse durch, auch wenn sie nicht ORIGIN ist", async () => {
		const session = createSession(db, ANNA);
		const res = await fetch(`${base}/api/sync`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				// Genau die Adresse, unter der diese Anfrage hereinkommt.
				origin: base,
				cookie: `tt_session=${session}`
			},
			body: JSON.stringify({ records: [rec("x")] })
		});
		expect(res.status).toBe(200);
	});

	it("weist eine wirklich fremde Seite weiterhin ab", async () => {
		const session = createSession(db, ANNA);
		const res = await fetch(`${base}/api/sync`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://boeswillig.example",
				cookie: `tt_session=${session}`
			},
			body: JSON.stringify({ records: [rec("x")] })
		});
		expect(res.status).toBe(403);
	});
});

describe("Verwaltung", () => {
	function makeAdmin(id: string) {
		db.$client.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(id);
	}

	it("weist einen gewoehnlichen Angemeldeten ab", async () => {
		expect((await api(annaToken, "/api/admin/invites")).status).toBe(403);
		const post = await api(annaToken, "/api/admin/invites", { method: "POST", body: "{}" });
		expect(post.status).toBe(403);
	});

	it("weist ohne Anmeldung ab", async () => {
		expect((await api(null, "/api/admin/invites")).status).toBe(401);
	});

	it("laesst einen Verwalter ausstellen und ansehen", async () => {
		makeAdmin(ANNA);
		const res = await api(annaToken, "/api/admin/invites", {
			method: "POST",
			body: JSON.stringify({ note: "für Bodo", validDays: 7 })
		});
		expect(res.status).toBe(201);
		const code = (await res.json()).code as string;
		// Vier Gruppen zu vier Zeichen - vorlesbar, ohne verwechselbare Zeichen.
		expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);

		const listed = await (await api(annaToken, "/api/admin/invites")).json();
		expect(listed.invites.some((i: { code: string }) => i.code === code)).toBe(true);
	});

	it("nimmt den alten Feldnamen gueltigTage weiter an", async () => {
		makeAdmin(ANNA);
		// Eine aeltere Desktop-Anwendung schickt noch gueltigTage. Ohne den Rueckfall
		// bekaeme sie stillschweigend einen Code ganz ohne Frist.
		const res = await api(annaToken, "/api/admin/invites", {
			method: "POST",
			body: JSON.stringify({ note: "alter Client", gueltigTage: 7 })
		});
		expect(res.status).toBe(201);

		const code = (await res.json()).code as string;
		const listed = await (await api(annaToken, "/api/admin/invites")).json();
		const row = listed.invites.find((i: { code: string }) => i.code === code);
		expect(row.expiresAt).not.toBeNull();
	});

	it("der ausgestellte Code oeffnet die Registrierung genau einmal", async () => {
		makeAdmin(ANNA);
		const { code } = await (
			await api(annaToken, "/api/admin/invites", { method: "POST", body: "{}" })
		).json();

		const first = await api(null, "/api/auth/register/start", {
			method: "POST",
			body: JSON.stringify({ displayName: "Neuling", invite: code })
		});
		expect(first.status).toBe(200);

		// Entwertet wird erst beim Anlegen des Kontos - ein abgebrochener Versuch
		// darf die Einladung nicht verbrauchen.
		db.$client.prepare("UPDATE invites SET used_at = ?, used_by = ? WHERE code = ?").run(
			Date.now(),
			"irgendwer",
			code
		);
		const secondB = await api(null, "/api/auth/register/start", {
			method: "POST",
			body: JSON.stringify({ displayName: "Noch einer", invite: code })
		});
		expect(secondB.status).toBe(403);
	});

	it("ein zurueckgezogener Code gilt nicht mehr", async () => {
		makeAdmin(ANNA);
		const { code } = await (
			await api(annaToken, "/api/admin/invites", { method: "POST", body: "{}" })
		).json();

		const gone = await api(annaToken, "/api/admin/invites", {
			method: "DELETE",
			body: JSON.stringify({ code })
		});
		expect(gone.status).toBe(200);

		const attempt = await api(null, "/api/auth/register/start", {
			method: "POST",
			body: JSON.stringify({ displayName: "Zu spät", invite: code })
		});
		expect(attempt.status).toBe(403);
	});

	it("ein abgelaufener Code gilt nicht mehr", async () => {
		makeAdmin(ANNA);
		const { code } = await (
			await api(annaToken, "/api/admin/invites", { method: "POST", body: "{}" })
		).json();
		db.$client
			.prepare("UPDATE invites SET expires_at = ? WHERE code = ?")
			.run(Date.now() - 1000, code);

		const attempt = await api(null, "/api/auth/register/start", {
			method: "POST",
			body: JSON.stringify({ displayName: "Zu spät", invite: code })
		});
		expect(attempt.status).toBe(403);
	});

	it("meldet die Rolle in /api/me", async () => {
		expect((await (await api(annaToken, "/api/me")).json()).isAdmin).toBe(false);
		makeAdmin(ANNA);
		expect((await (await api(annaToken, "/api/me")).json()).isAdmin).toBe(true);
	});

	it("ein Verwalter kommt trotzdem nicht an fremde Daten", async () => {
		makeAdmin(ANNA);
		await api(bodoToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("b1")] })
		});
		// Die Rolle regelt, wer hereindarf - nicht, wer etwas sieht. Auch als
		// Verwalter sieht Anna ausschliesslich ihr eigenes Konto.
		const pageNo = await (await api(annaToken, "/api/sync?since=0")).json();
		expect(pageNo.records).toHaveLength(0);
		expect((await (await api(annaToken, "/api/me")).json()).userId).toBe(ANNA);
	});

	it("laesst statische Einladungscodes per PATCH deaktivieren und aktivieren", async () => {
		makeAdmin(ANNA);
		const get1 = await (await api(annaToken, "/api/admin/invites")).json();
		expect(get1).toHaveProperty("envInvitesConfigured");
		expect(get1).toHaveProperty("envInvitesActive");
		expect(get1).toHaveProperty("openRegistration");

		// Deaktivieren
		const patch1 = await api(annaToken, "/api/admin/invites", {
			method: "PATCH",
			body: JSON.stringify({ active: false })
		});
		expect(patch1.status).toBe(200);
		const res1 = await patch1.json();
		expect(res1.ok).toBe(true);

		// Wieder aktivieren
		const patch2 = await api(annaToken, "/api/admin/invites", {
			method: "PATCH",
			body: JSON.stringify({ active: true })
		});
		expect(patch2.status).toBe(200);
		const res2 = await patch2.json();
		expect(res2.ok).toBe(true);
	});

	it("laesst offene Registrierung per PATCH aktivieren und deaktivieren", async () => {
		makeAdmin(ANNA);
		// Aktivieren
		const patch1 = await api(annaToken, "/api/admin/invites", {
			method: "PATCH",
			body: JSON.stringify({ openRegistration: true })
		});
		expect(patch1.status).toBe(200);
		const res1 = await patch1.json();
		expect(res1.openRegistration).toBe(true);

		// Deaktivieren
		const patch2 = await api(annaToken, "/api/admin/invites", {
			method: "PATCH",
			body: JSON.stringify({ openRegistration: false })
		});
		expect(patch2.status).toBe(200);
		const res2 = await patch2.json();
		expect(res2.openRegistration).toBe(false);
	});

	it("erlaubt einem Verwalter Backups aufzulisten, anzulegen, wiederherzustellen und zu löschen", async () => {
		makeAdmin(ANNA);
		// 1. Manuelles Backup erstellen
		const postRes = await api(annaToken, "/api/admin/backups", { method: "POST" });
		expect(postRes.status).toBe(201);
		const postData = await postRes.json();
		expect(postData.ok).toBe(true);
		expect(postData.backup.name).toMatch(/^timetracker-backup-/);

		// 2. Backups auflisten
		const getRes = await api(annaToken, "/api/admin/backups");
		expect(getRes.status).toBe(200);
		const getData = await getRes.json();
		expect(Array.isArray(getData.backups)).toBe(true);
		expect(getData.backups.some((b: { name: string }) => b.name === postData.backup.name)).toBe(true);

		// 3. Backup wiederherstellen
		const restoreRes = await api(annaToken, "/api/admin/backups/restore", {
			method: "POST",
			body: JSON.stringify({ name: postData.backup.name })
		});
		expect(restoreRes.status).toBe(200);
		const restoreData = await restoreRes.json();
		expect(restoreData.ok).toBe(true);
		expect(restoreData.restored).toBe(postData.backup.name);

		// 4. Backup löschen
		const delRes = await api(annaToken, "/api/admin/backups", {
			method: "DELETE",
			body: JSON.stringify({ name: postData.backup.name })
		});
		expect(delRes.status).toBe(200);

		// Nicht-Verwalter wird abgewiesen
		expect((await api(bodoToken, "/api/admin/backups")).status).toBe(403);
	});
});

/** Eine Anfrage mit selbst gesetzter Host-Kopfzeile. */
async function rawRequest(headers: Record<string, string>): Promise<number> {
	const { request } = await import("node:http");
	const bodyText = JSON.stringify({ records: [rec("roh")] });
	return new Promise<number>((resolve, reject) => {
		const req = request(
			{
				hostname: "127.0.0.1",
				port,
				path: "/api/sync",
				method: "POST",
				headers: { "content-type": "application/json", "content-length": bodyText.length, ...headers }
			},
			(res) => {
				res.resume();
				res.on("end", () => resolve(res.statusCode ?? 0));
			}
		);
		req.on("error", reject);
		req.end(bodyText);
	});
}

describe("Herkunft unter einem fremden Namen", () => {
	// ORIGIN sagt "localhost:<Port>". Jemand erreicht den Dienst aber ueber den
	// Rechnernamen im Heimnetz - und ist damit trotzdem auf der eigenen Seite.
	it("laesst durch, wenn Origin und Host zueinander passen", async () => {
		const session = createSession(db, ANNA);
		// Mit `fetch` geht das nicht: die Host-Kopfzeile ist geschuetzt und wird
		// immer auf die tatsaechliche Zieladresse gesetzt. Genau die soll hier aber
		// eine andere sein - also von Hand.
		const res = await rawRequest({
			host: "tracker.fritz.box",
			origin: "http://tracker.fritz.box",
			cookie: `tt_session=${session}`
		});
		expect(res).toBe(200);
	});

	it("weist ab, wenn Origin nicht zum Host passt", async () => {
		const session = createSession(db, ANNA);
		const res = await fetch(`${base}/api/sync`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				host: "tracker.fritz.box",
				origin: "https://boeswillig.example",
				cookie: `tt_session=${session}`
			},
			body: JSON.stringify({ records: [rec("x")] })
		});
		expect(res.status).toBe(403);
	});

	it("beruecksichtigt die weitergereichte Kopfzeile hinter einem Proxy", async () => {
		const session = createSession(db, ANNA);
		const res = await fetch(`${base}/api/sync`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-forwarded-host": "tracker.example.de",
				origin: "https://tracker.example.de",
				cookie: `tt_session=${session}`
			},
			body: JSON.stringify({ records: [rec("x")] })
		});
		expect(res.status).toBe(200);
	});
});

describe("Passkeys verwalten", () => {
	/** Einen Passkey direkt eintragen - ohne Authentifikator geht es nicht anders. */
	function addPasskey(userId: string, id: string, label: string | null = null) {
		db.$client
			.prepare(
				"INSERT INTO credentials (id, user_id, public_key, counter, has_prf, label, created_at) VALUES (?,?,?,0,1,?,?)"
			)
			.run(id, userId, Buffer.from([1, 2, 3]), label, Date.now());
	}

	it("verlangt eine Anmeldung", async () => {
		expect((await api(null, "/api/passkeys")).status).toBe(401);
		expect((await api(null, "/api/passkeys/start", { method: "POST" })).status).toBe(401);
		expect((await api(null, "/api/passkeys", { method: "DELETE", body: "{}" })).status).toBe(401);
	});

	it("listet nur die eigenen", async () => {
		addPasskey(ANNA, "annas-schluessel", "Annas Laptop");
		addPasskey(BODO, "bodos-schluessel", "Bodos Handy");

		const { passkeys } = await (await api(annaToken, "/api/passkeys")).json();
		expect(passkeys).toHaveLength(1);
		expect(passkeys[0].label).toBe("Annas Laptop");
	});

	it("schliesst beim Anlegen die vorhandenen aus", async () => {
		// Sonst legt derselbe Authentifikator einen zweiten Passkey fuer dasselbe
		// Konto an - und der Mensch glaubt, er haette jetzt zwei Wege, obwohl beide
		// an demselben Geraet haengen.
		addPasskey(ANNA, "schon-da");
		const { options } = await (
			await api(annaToken, "/api/passkeys/start", { method: "POST" })
		).json();
		expect(options.excludeCredentials.map((c: { id: string }) => c.id)).toContain("schon-da");
	});

	it("laesst sich umbenennen", async () => {
		addPasskey(ANNA, "annas-schluessel", "Alt");
		const res = await api(annaToken, "/api/passkeys", {
			method: "PATCH",
			body: JSON.stringify({ id: "annas-schluessel", label: "Der alte Rechner" })
		});
		expect(res.status).toBe(200);
		const { passkeys } = await (await api(annaToken, "/api/passkeys")).json();
		expect(passkeys[0].label).toBe("Der alte Rechner");
	});

	it("laesst KEINEN fremden umbenennen", async () => {
		addPasskey(BODO, "bodos-schluessel", "Bodos Handy");
		const res = await api(annaToken, "/api/passkeys", {
			method: "PATCH",
			body: JSON.stringify({ id: "bodos-schluessel", label: "gekapert" })
		});
		expect(res.status).toBe(404);
	});

	it("entfernt einen von mehreren - samt seiner Verpackung", async () => {
		addPasskey(ANNA, "alter-rechner", "Alter Rechner");
		addPasskey(ANNA, "neues-handy", "Neues Handy");
		await api(annaToken, "/api/wraps", {
			method: "POST",
			body: JSON.stringify({ kind: "passkey", payload: "verpackt", credentialId: "alter-rechner" })
		});

		const res = await api(annaToken, "/api/passkeys", {
			method: "DELETE",
			body: JSON.stringify({ id: "alter-rechner" })
		});
		expect(res.status).toBe(200);

		const { passkeys } = await (await api(annaToken, "/api/passkeys")).json();
		expect(passkeys.map((p: { id: string }) => p.id)).toEqual(["neues-handy"]);

		// Die Verpackung ist ohne ihren Passkey nicht mehr zu oeffnen - sie stehen
		// zu lassen hiesse, eine Tuer ohne Schluessel zu verwahren.
		const { wraps } = await (await api(annaToken, "/api/wraps")).json();
		expect(wraps.some((w: { credentialId: string }) => w.credentialId === "alter-rechner")).toBe(
			false
		);
	});

	it("entfernt den LETZTEN nicht", async () => {
		// Die Grenze, die nicht verhandelbar ist: ohne Passkey kommt niemand mehr
		// in das Konto. Die Phrase entsperrt die DATEN, aber sie meldet niemanden
		// an - und der Betreiber kann auch nicht helfen.
		addPasskey(ANNA, "der-einzige", "Der einzige");
		const res = await api(annaToken, "/api/passkeys", {
			method: "DELETE",
			body: JSON.stringify({ id: "der-einzige" })
		});
		expect(res.status).toBe(409);

		const { passkeys } = await (await api(annaToken, "/api/passkeys")).json();
		expect(passkeys).toHaveLength(1);
	});

	it("laesst KEINEN fremden entfernen", async () => {
		addPasskey(ANNA, "annas-eigener");
		addPasskey(BODO, "bodos-erster");
		addPasskey(BODO, "bodos-zweiter");

		const res = await api(annaToken, "/api/passkeys", {
			method: "DELETE",
			body: JSON.stringify({ id: "bodos-zweiter" })
		});
		expect(res.status).toBe(404);

		const { passkeys } = await (await api(bodoToken, "/api/passkeys")).json();
		expect(passkeys).toHaveLength(2);
	});

	it("nimmt keine Aufgabe an, die zu einem anderen Konto gehoert", async () => {
		const { challengeId } = await (
			await api(bodoToken, "/api/passkeys/start", { method: "POST" })
		).json();
		const res = await api(annaToken, "/api/passkeys/finish", {
			method: "POST",
			body: JSON.stringify({ challengeId, response: {}, hasPrf: false })
		});
		expect(res.status).toBe(403);
	});
});

describe("Konto von einem Geraet aus anlegen", () => {
	/** Die Registrierung ist geschlossen - also braucht jeder Versuch eine Einladung. */
	function inviteRow(): string {
		const code = `TEST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
		db.$client
			.prepare("INSERT INTO invites (code, created_at) VALUES (?, ?)")
			.run(code, Date.now());
		return code;
	}

	it("verlangt eine Einladung", async () => {
		const res = await api(null, "/api/auth/device", {
			method: "POST",
			body: JSON.stringify({ label: "Rechner" })
		});
		expect(res.status).toBe(403);
	});

	it("weist einen masslosen Namen ab", async () => {
		const res = await api(null, "/api/auth/device", {
			method: "POST",
			body: JSON.stringify({ displayName: "x".repeat(200), label: "R", invite: inviteRow() })
		});
		expect(res.status).toBe(400);
	});

	it("legt Konto und Geraet in einem Zug an", async () => {
		const res = await api(null, "/api/auth/device", {
			method: "POST",
			body: JSON.stringify({ displayName: "Neuling", label: "Neulings Rechner", invite: inviteRow() })
		});
		expect(res.status).toBe(200);
		const { userId, deviceToken } = await res.json();
		expect(deviceToken).toBeTruthy();

		// Das Token traegt sofort - ohne das waere das Konto unerreichbar, denn
		// einen Passkey gibt es hier nicht.
		const self = await (await api(deviceToken, "/api/me")).json();
		expect(self.userId).toBe(userId);
		expect(self.displayName).toBe("Neuling");
		expect(self.passkeys).toHaveLength(0);
		expect(self.devices).toHaveLength(1);
	});

	it("kann sofort abgleichen", async () => {
		// Der eigentliche Zweck: die Daten liegen auf diesem Rechner und sollen
		// hoch. Ein Konto, das erst noch einen Passkey braucht, waere ein Umweg.
		const { deviceToken } = await (
			await api(null, "/api/auth/device", {
				method: "POST",
				body: JSON.stringify({ displayName: "Neuling", label: "Rechner", invite: inviteRow() })
			})
		).json();

		const up = await api(deviceToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("e1"), rec("e2")] })
		});
		expect(up.status).toBe(200);
		expect((await up.json()).accepted).toHaveLength(2);
	});

	it("nimmt die Verpackung der Phrase an", async () => {
		const { deviceToken } = await (
			await api(null, "/api/auth/device", {
				method: "POST",
				body: JSON.stringify({ displayName: "Neuling", label: "Rechner", invite: inviteRow() })
			})
		).json();

		const res = await api(deviceToken, "/api/wraps", {
			method: "POST",
			body: JSON.stringify({ kind: "recovery", payload: "verpackt" })
		});
		expect(res.status).toBe(200);

		// Ohne sie waere das Konto an genau dieses eine Geraet gebunden.
		const { wraps } = await (await api(deviceToken, "/api/wraps")).json();
		expect(wraps.map((w: { kind: string }) => w.kind)).toContain("recovery");
	});
});

describe("Herkunft ohne Sitzung", () => {
	// Die Desktop-Anwendung legt ein Konto an, hat noch kein Token - das bekommt
	// sie ja gerade erst - und schickt trotzdem eine Herkunft mit, weil ein
	// Fenster nun einmal eine hat.
	it("laesst eine Anfrage ohne Cookie durch, egal woher sie kommt", async () => {
		db.$client.prepare("INSERT INTO invites (code, created_at) VALUES (?, ?)").run("HERK-TEST", Date.now());
		const res = await api(null, "/api/auth/device", {
			method: "POST",
			headers: { origin: "http://tauri.localhost" },
			body: JSON.stringify({ displayName: "Vom Rechner", label: "Rechner", invite: "HERK-TEST" })
		});
		expect(res.status).toBe(200);
	});

	it("weist eine fremde Seite MIT Sitzung weiterhin ab", async () => {
		// Hier faehrt der Ausweis automatisch mit - und genau darum geht es.
		const session = createSession(db, ANNA);
		const res = await fetch(`${base}/api/sync`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://boeswillig.example",
				cookie: `tt_session=${session}`
			},
			body: JSON.stringify({ records: [rec("x")] })
		});
		expect(res.status).toBe(403);
	});
});

describe("Anlegen ohne Namen", () => {
	it("kommt ohne Anzeigename aus", async () => {
		// Der Name steht nur im Anmeldedialog des Betriebssystems, und den sieht
		// dieses Konto nie - es hat keinen Passkey. Danach zu fragen waere eine
		// Zeile im Formular, die niemandem etwas bringt.
		db.$client
			.prepare("INSERT INTO invites (code, created_at) VALUES (?, ?)")
			.run("OHNE-NAME", Date.now());
		const res = await api(null, "/api/auth/device", {
			method: "POST",
			body: JSON.stringify({ label: "Rechner", invite: "OHNE-NAME" })
		});
		expect(res.status).toBe(200);
		const { userId, displayName, deviceToken } = await res.json();
		// Ohne Namen steht die Kennung da - haesslich und ehrlich.
		expect(displayName).toBe(userId);

		// Und das Konto ist sofort brauchbar.
		const self = await (await api(deviceToken, "/api/me")).json();
		expect(self.devices[0].label).toBe("Rechner");
	});
});

describe("Wiederherstellung mit der Phrase", () => {
	/** Kennung und Nachweis hinterlegen - genau so, wie die Anwendung es tut. */
	function store(token: string, fields: Record<string, unknown>) {
		return api(token, "/api/wraps", {
			method: "POST",
			body: JSON.stringify({ kind: "recovery", payload: "verpacktes-chiffrat", ...fields })
		});
	}

	function account(id: string) {
		return db.$client.prepare("SELECT recovery_id, vault_proof FROM users WHERE id = ?").get(id) as {
			recovery_id: string | null;
			vault_proof: string | null;
		};
	}

	function countWraps(id: string) {
		return (
			db.$client
				.prepare("SELECT count(*) AS n FROM key_wraps WHERE user_id = ?")
				.get(id) as { n: number }
		).n;
	}

	it("gibt die Verpackung zu einer bekannten Kennung heraus", async () => {
		await store(annaToken, { recoveryId: "kennung-anna", vaultProof: "beweis-anna" });
		const res = await apiFrom(null, "/api/auth/recover", {
			method: "POST",
			body: JSON.stringify({ recoveryId: "kennung-anna" })
		});
		expect(res.status).toBe(200);
		expect((await res.json()).wrap).toBe("verpacktes-chiffrat");
	});

	it("verraet nicht, ob es ein Konto gibt", async () => {
		// Dieselbe Meldung fuer "kenne ich nicht" und "hat keine Verpackung" -
		// sonst laesst sich durchprobieren, welche Konten existieren.
		const res = await apiFrom(null, "/api/auth/recover", {
			method: "POST",
			body: JSON.stringify({ recoveryId: "gibt-es-nicht" })
		});
		expect(res.status).toBe(404);
	});

	it("gibt OHNE Nachweis kein Geraete-Token", async () => {
		// Der Kern: wer die Kennung aus einer gestohlenen Datenbank abliest,
		// bekommt die Verpackung - die er nicht oeffnen kann - und sonst nichts.
		await store(annaToken, { recoveryId: "kennung-anna", vaultProof: "beweis-anna" });
		const res = await apiFrom(null, "/api/auth/recover", {
			method: "POST",
			body: JSON.stringify({ recoveryId: "kennung-anna" })
		});
		const answer = await res.json();
		expect(answer.deviceToken).toBeUndefined();
		expect(answer.wrap).toBeTruthy();
	});

	it("weist einen falschen Nachweis ab", async () => {
		await store(annaToken, { recoveryId: "kennung-anna", vaultProof: "beweis-anna" });
		const res = await apiFrom(null, "/api/auth/recover", {
			method: "POST",
			body: JSON.stringify({ recoveryId: "kennung-anna", proof: "erfunden", label: "Neu" })
		});
		expect(res.status).toBe(401);
	});

	it("meldet mit richtigem Nachweis ein Geraet an", async () => {
		await store(annaToken, { recoveryId: "kennung-anna", vaultProof: "beweis-anna" });
		const res = await apiFrom(null, "/api/auth/recover", {
			method: "POST",
			body: JSON.stringify({
				recoveryId: "kennung-anna",
				proof: "beweis-anna",
				label: "Neuer Rechner"
			})
		});
		expect(res.status).toBe(200);
		const { userId, deviceToken } = await res.json();
		expect(userId).toBe(ANNA);

		// Und das Token traegt sofort - die Daten sind ja noch da, nur der Zugang
		// war weg.
		const self = await (await api(deviceToken, "/api/me")).json();
		expect(self.userId).toBe(ANNA);
		expect(self.devices.some((d: { label: string }) => d.label === "Neuer Rechner")).toBe(true);
	});

	it("fuehrt nicht zu einem fremden Konto", async () => {
		await store(annaToken, { recoveryId: "kennung-anna", vaultProof: "beweis-anna" });
		await store(bodoToken, { recoveryId: "kennung-bodo", vaultProof: "beweis-bodo" });
		const res = await apiFrom(null, "/api/auth/recover", {
			method: "POST",
			body: JSON.stringify({ recoveryId: "kennung-anna", proof: "beweis-bodo", label: "X" })
		});
		expect(res.status).toBe(401);
	});

	it("legt den Nachweis nur als Hash ab", async () => {
		// Sonst genuegte ein Datenbankabzug: abschreiben, zurueckschicken, Token.
		await store(annaToken, { recoveryId: "kennung-anna", vaultProof: "beweis" });
		expect(account(ANNA).vault_proof).toBe(hashSecret("beweis"));
	});

	it("nimmt Kennung und Nachweis nur zusammen an", async () => {
		// Eines allein wuerde das andere ueberschreiben.
		await store(annaToken, { recoveryId: "kennung-anna", vaultProof: "beweis" });
		expect((await store(annaToken, { recoveryId: "andere-kennung" })).status).toBe(400);
		expect((await store(annaToken, { vaultProof: "anderer-beweis" })).status).toBe(400);
		expect(account(ANNA)).toEqual({ recovery_id: "kennung-anna", vault_proof: hashSecret("beweis") });
	});

	it("weist eine bereits vergebene Kennung ab - und schreibt dabei nichts", async () => {
		await store(annaToken, { recoveryId: "kennung-anna", vaultProof: "beweis-anna" });
		const res = await store(bodoToken, { recoveryId: "kennung-anna", vaultProof: "beweis-bodo" });
		expect(res.status).toBe(409);
		// Der Abbruch nimmt alles mit: keine halbe Zeile, keine Verpackung.
		expect(account(BODO)).toEqual({ recovery_id: null, vault_proof: null });
		expect(countWraps(BODO)).toBe(0);
	});

	it("laesst eine neue Phrase die alte ersetzen", async () => {
		await store(annaToken, { recoveryId: "kennung-alt", vaultProof: "beweis-alt" });
		await store(annaToken, { recoveryId: "kennung-neu", vaultProof: "beweis-neu" });
		expect(countWraps(ANNA)).toBe(1);
		const old = await apiFrom(null, "/api/auth/recover", {
			method: "POST",
			body: JSON.stringify({ recoveryId: "kennung-alt" })
		});
		expect(old.status).toBe(404);
	});

	it("bremst das Durchprobieren des Nachweises", async () => {
		// Eine feste Adresse fuer alle Versuche - die Bremse zaehlt je Aufrufer.
		await store(annaToken, { recoveryId: "kennung-anna", vaultProof: "beweis-anna" });
		let throttled = false;
		for (let i = 0; i < 30 && !throttled; i++) {
			const res = await api(null, "/api/auth/recover", {
				method: "POST",
				headers: { "x-echte-adresse": "10.9.9.9" },
				body: JSON.stringify({ recoveryId: "kennung-anna", proof: `versuch-${i}`, label: "X" })
			});
			throttled = res.status === 429;
			if (throttled) expect(res.headers.get("retry-after")).toBeTruthy();
		}
		expect(throttled).toBe(true);
	});
});

describe("Telemetrie", () => {
	/** Ein Ping mit eigener Adresse - sonst nimmt ein Test dem naechsten die Bremse weg. */
	function ping(body: unknown, key: string | null = TELEMETRY_KEY) {
		return apiFrom(null, "/api/telemetry", {
			method: "POST",
			headers: key === null ? {} : { "x-telemetry-key": key },
			body: JSON.stringify(body)
		});
	}

	const goodPing = { deviceId: "geraet-abcd-1234", version: "0.9.3", platform: "macos" };

	it("nimmt einen Ping mit dem richtigen Schluessel an", async () => {
		const res = await ping(goodPing);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("weist einen Ping ohne Schluessel ab", async () => {
		expect((await ping(goodPing, null)).status).toBe(401);
	});

	it("weist einen Ping mit falschem Schluessel ab", async () => {
		expect((await ping(goodPing, "falsch")).status).toBe(401);
		// Gleiche Laenge, anderer Inhalt: der Vergleich darf nicht am Praefix haengen.
		expect((await ping(goodPing, "x".repeat(TELEMETRY_KEY.length))).status).toBe(401);
	});

	it("weist zu kurze und zu lange Geraetekennungen ab", async () => {
		expect((await ping({ ...goodPing, deviceId: "ab" })).status).toBe(400);
		expect((await ping({ ...goodPing, deviceId: "x".repeat(65) })).status).toBe(400);
	});

	it("uebernimmt keine erfundenen Versionen und Plattformen", async () => {
		const res = await ping({
			deviceId: "geraet-mit-muell",
			version: "<script>alert(1)</script>",
			platform: "Erfundenes"
		});
		expect(res.status).toBe(200);

		const row = db
			.select()
			.from(telemetryPings)
			.all()
			.find((r) => r.deviceId === "geraet-mit-muell");
		expect(row?.version).toBe("unbekannt");
		expect(row?.platform).toBe("unbekannt");
	});
});
