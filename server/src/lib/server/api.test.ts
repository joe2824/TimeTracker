// Durchstich durch die Endpunkte - gegen einen echten Server, ueber echtes HTTP.
//
// Die Einzeltests in sync.test.ts pruefen die Rechnung. Hier geht es um das,
// was nur an der Aussenkante schiefgehen kann: greift die Anmeldung wirklich,
// sieht ein fremdes Konto wirklich nichts, weckt der Ereigniskanal wirklich.
//
// Passkeys lassen sich ohne Authentifikator nicht durchspielen. Die Konten
// entstehen deshalb direkt in der Datenbank, und die Anfragen weisen sich mit
// einem Geraete-Token aus - genau so, wie es der Desktop tut.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db";
import { users } from "./db/schema";
import { createDevice } from "./auth";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

let base: string;
let db: Db;
let dir: string;
let server: { close(): void };

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
	process.env.ORIGIN = "http://localhost:5199";
	process.env.RP_ID = "localhost";

	db = openDb(dbFile).db;

	// Den gebauten Server starten. Er liest DB_FILE aus der Umgebung und oeffnet
	// dieselbe Datei - beide Seiten sehen damit denselben Bestand.
	// Der GEBAUTE Server, nicht die Quellen: nur so ist geprueft, was spaeter
	// wirklich laeuft - samt Adapter, Kompilat und Aufloesung der Abhaengigkeiten.
	//
	// Bewusst ohne Typen: das Kompilat hat keine, und ihm welche anzudichten
	// hiesse, eine Zusage zu machen, die niemand einhaelt.
	//
	// Der Pfad wird zur LAUFZEIT gebildet: stuende er als Zeichenkette im Import,
	// wuerde TypeScript das Kompilat mitpruefen - tausende Fehler in Code, den
	// niemand geschrieben hat.
	const handlerPfad = new URL("../../../build/handler.js", import.meta.url).href;
	const built = (await import(/* @vite-ignore */ handlerPfad)) as {
		handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
	};
	const { createServer } = await import("node:http");
	const http = createServer((req, res) => built.handler(req, res, () => {}));
	await new Promise<void>((r) => http.listen(5199, r));
	server = { close: () => http.close() };
	base = "http://localhost:5199";
});

afterAll(() => {
	server?.close();
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

	it("weist ein widerrufenes Geraet ab", async () => {
		const me = await (await api(annaToken, "/api/me")).json();
		const deviceId = me.devices[0].id;
		const weg = await api(annaToken, "/api/devices", {
			method: "DELETE",
			body: JSON.stringify({ deviceId })
		});
		expect(weg.status).toBe(200);
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
		const zweit = await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("e1", { baseRev: 0 })] })
		});
		const body = await zweit.json();
		expect(body.accepted).toEqual([]);
		expect(body.conflicts).toHaveLength(1);
	});

	it("weist einen masslosen Stapel ab", async () => {
		const zuViele = Array.from({ length: 501 }, (_, i) => rec(`e${i}`));
		const r = await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: zuViele })
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

	it("weist eine unbekannte Art ab", async () => {
		const r = await api(annaToken, "/api/wraps", {
			method: "POST",
			body: JSON.stringify({ kind: "hintertuer", payload: "eA==" })
		});
		expect(r.status).toBe(400);
	});
});

describe("Kopplung", () => {
	it("laeuft vom Code bis zum Token durch", async () => {
		// Schritt 1 auf dem neuen Geraet - ohne Anmeldung.
		const start = await (
			await api(null, "/api/pair/start", {
				method: "POST",
				body: JSON.stringify({ publicKey: "b2VmZmVudGxpY2g=", label: "Handy" })
			})
		).json();
		expect(start.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);

		// Noch nichts abzuholen.
		const frueh = await (
			await api(null, "/api/pair/claim", {
				method: "POST",
				body: JSON.stringify({ code: start.code })
			})
		).json();
		expect(frueh.pending).toBe(true);

		// Schritt 2 auf dem entsperrten Geraet.
		const gesehen = await (await api(annaToken, `/api/pair/approve?code=${start.code}`)).json();
		expect(gesehen.publicKey).toBe("b2VmZmVudGxpY2g=");
		const ok = await api(annaToken, "/api/pair/approve", {
			method: "POST",
			body: JSON.stringify({ code: start.code, wrappedKey: "cGFrZXQ=" })
		});
		expect(ok.status).toBe(200);

		// Schritt 3 zurueck auf dem neuen Geraet.
		const claim = await (
			await api(null, "/api/pair/claim", {
				method: "POST",
				body: JSON.stringify({ code: start.code })
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
				body: JSON.stringify({ publicKey: "cHVi", label: "Handy" })
			})
		).json();
		await api(annaToken, "/api/pair/approve", {
			method: "POST",
			body: JSON.stringify({ code: start.code, wrappedKey: "cGFrZXQ=" })
		});
		const body = JSON.stringify({ code: start.code });
		expect((await (await api(null, "/api/pair/claim", { method: "POST", body })).json()).pending).toBe(false);
		expect((await api(null, "/api/pair/claim", { method: "POST", body })).status).toBe(404);
	});

	it("laesst denselben Code nicht zweimal bestaetigen", async () => {
		const start = await (
			await api(null, "/api/pair/start", {
				method: "POST",
				body: JSON.stringify({ publicKey: "cHVi", label: "Handy" })
			})
		).json();
		const body = JSON.stringify({ code: start.code, wrappedKey: "cGFrZXQ=" });
		expect((await api(annaToken, "/api/pair/approve", { method: "POST", body })).status).toBe(200);
		expect((await api(bodoToken, "/api/pair/approve", { method: "POST", body })).status).toBe(409);
	});

	it("weist einen unbekannten Code ab", async () => {
		expect((await api(annaToken, "/api/pair/approve?code=XXXXXXXX")).status).toBe(404);
	});

	it("verlangt fuer das Bestaetigen eine Anmeldung", async () => {
		const r = await api(null, "/api/pair/approve", {
			method: "POST",
			body: JSON.stringify({ code: "XXXXXXXX", wrappedKey: "eA==" })
		});
		expect(r.status).toBe(401);
	});
});

describe("Ereigniskanal", () => {
	it("meldet den aktuellen Stand und weckt bei einer Aenderung", async () => {
		const ac = new AbortController();
		const antwort = await fetch(`${base}/api/sync/stream`, {
			headers: { authorization: `Bearer ${annaToken}` },
			signal: ac.signal
		});
		expect(antwort.headers.get("content-type")).toContain("text/event-stream");

		const reader = antwort.body!.getReader();
		const dec = new TextDecoder();
		const lies = async () => dec.decode((await reader.read()).value);

		expect(await lies()).toContain("event: hello");

		// Ein zweites Geraet schreibt - der Kanal muss davon erzaehlen.
		await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("e1")] })
		});
		const nachricht = await lies();
		expect(nachricht).toContain("event: change");
		expect(nachricht).toContain('"seq":1');

		ac.abort();
		await reader.cancel().catch(() => {});
	});

	it("erzaehlt nicht von den Aenderungen eines fremden Kontos", async () => {
		const ac = new AbortController();
		const antwort = await fetch(`${base}/api/sync/stream`, {
			headers: { authorization: `Bearer ${bodoToken}` },
			signal: ac.signal
		});
		const reader = antwort.body!.getReader();
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
