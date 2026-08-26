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
import { createDevice, createSession } from "./auth";
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
	process.env.ALLOWED_ORIGINS = "http://localhost:5199";

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

describe("Konto aufloesen", () => {
	/** Was Anna alles beim Server hat, bevor sie es aufloest. */
	async function annaFuellen() {
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
		const sitzung = createSession(db, ANNA);
		const res = await fetch(`${base}/api/me`, {
			method: "DELETE",
			headers: { "content-type": "application/json", cookie: `tt_session=${sitzung}` },
			body: "{}"
		});
		expect(res.status).toBe(400);

		// Und das Konto steht noch.
		expect((await api(annaToken, "/api/me")).status).toBe(200);
	});

	it("weist eine erfundene Bestaetigung ab", async () => {
		const sitzung = createSession(db, ANNA);
		const start = await fetch(`${base}/api/me/confirm`, {
			method: "POST",
			headers: { cookie: `tt_session=${sitzung}` }
		});
		// Anna hat keinen Passkey (die Konten entstehen hier direkt in der
		// Datenbank) - dann gibt es auch nichts zu bestaetigen, und der Weg ueber
		// die Sitzung ist verschlossen. Genau richtig: einen Passkey vorzutaeuschen
		// darf nicht gehen.
		expect(start.status).toBe(409);

		// Eine zusammengereimte Antwort wird ebenfalls nicht angenommen.
		const res = await fetch(`${base}/api/me`, {
			method: "DELETE",
			headers: { "content-type": "application/json", cookie: `tt_session=${sitzung}` },
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
		await annaFuellen();

		const res = await api(annaToken, "/api/me", { method: "DELETE", body: "{}" });
		expect(res.status).toBe(200);
		const summe = await res.json();
		expect(summe).toMatchObject({ ok: true, records: 3, wraps: 1, devices: 1 });

		// Nicht der Meldung glauben, sondern nachsehen: in der Datenbank selbst
		// darf zu diesem Konto keine einzige Zeile mehr stehen.
		const zaehle = (tabelle: string) =>
			(
				db.$client.prepare(`SELECT count(*) AS n FROM ${tabelle} WHERE user_id = ?`).get(ANNA) as {
					n: number;
				}
			).n;
		expect(zaehle("records")).toBe(0);
		expect(zaehle("key_wraps")).toBe(0);
		expect(zaehle("devices")).toBe(0);
		expect(zaehle("credentials")).toBe(0);
		expect(zaehle("sessions")).toBe(0);
		expect(
			(db.$client.prepare(`SELECT count(*) AS n FROM users WHERE id = ?`).get(ANNA) as { n: number })
				.n
		).toBe(0);
	});

	it("laesst das Konto daneben unangetastet", async () => {
		await annaFuellen();
		await api(bodoToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("b1"), rec("b2")] })
		});

		await api(annaToken, "/api/me", { method: "DELETE", body: "{}" });

		// Bodo merkt von alldem nichts. Das ist der Punkt, an dem sich zeigt, ob
		// die Loeschung wirklich auf ein Konto eingeschraenkt war.
		const seite = await (await api(bodoToken, "/api/sync?since=0")).json();
		expect(seite.records.map((r: { id: string }) => r.id).sort()).toEqual(["b1", "b2"]);
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
		const antwort = await res.json();
		expect(antwort.accepted).toHaveLength(0);
		expect(antwort.conflicts).toHaveLength(1);
		expect(antwort.conflicts[0].current.rev).toBe(0);
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
		const zweites = createDevice(db, ANNA, "Annas Handy").token;

		await api(annaToken, "/api/devices", { method: "DELETE", body: "{}" });

		// Das andere Geraet arbeitet weiter, und die Daten sind vollstaendig da.
		// Genau hierin unterscheidet sich "Geraet loesen" vom Aufloesen.
		const seite = await (await api(zweites, "/api/sync?since=0")).json();
		expect(seite.records).toHaveLength(1);
	});

	it("gibt eine Sitzung ohne Geraet nicht als Geraet aus", async () => {
		// Ohne Token und ohne Angabe gibt es nichts zu loesen. Waere das ein
		// stiller Erfolg, haette der Aufrufer den Eindruck, etwas sei passiert.
		const res = await api(null, "/api/devices", { method: "DELETE", body: "{}" });
		expect(res.status).toBe(401);
	});
});

describe("Bremse und Herkunft", () => {
	it("bremst das Abfragen eines Kopplungscodes", async () => {
		// Der Endpunkt ist ohne Anmeldung erreichbar und gibt bei einem Treffer ein
		// Geraete-Token heraus. Der Code hat vierzig Bit - rechnerisch nicht zu
		// raten. Aber "rechnerisch nicht" ist eine Aussage ueber einen Angreifer,
		// der ehrlich rechnet, nicht ueber einen, der oft fragt.
		let gebremst = false;
		for (let i = 0; i < 40; i++) {
			const res = await api(null, "/api/pair/claim", {
				method: "POST",
				body: JSON.stringify({ code: `RATEN${i}` })
			});
			if (res.status === 429) {
				gebremst = true;
				expect(res.headers.get("retry-after")).toBeTruthy();
				break;
			}
		}
		expect(gebremst).toBe(true);
	});

	it("weist eine schreibende Anfrage von fremder Herkunft ab", async () => {
		const sitzung = createSession(db, ANNA);
		const res = await fetch(`${base}/api/sync`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://boeswillig.example",
				cookie: `tt_session=${sitzung}`
			},
			body: JSON.stringify({ records: [rec("x")] })
		});
		expect(res.status).toBe(403);
	});

	it("laesst die eigene Herkunft durch", async () => {
		const sitzung = createSession(db, ANNA);
		const res = await fetch(`${base}/api/sync`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:5199",
				cookie: `tt_session=${sitzung}`
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
		const sitzung = createSession(db, ANNA);
		const res = await fetch(`${base}/api/sync`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				// Genau die Adresse, unter der diese Anfrage hereinkommt.
				origin: base,
				cookie: `tt_session=${sitzung}`
			},
			body: JSON.stringify({ records: [rec("x")] })
		});
		expect(res.status).toBe(200);
	});

	it("weist eine wirklich fremde Seite weiterhin ab", async () => {
		const sitzung = createSession(db, ANNA);
		const res = await fetch(`${base}/api/sync`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://boeswillig.example",
				cookie: `tt_session=${sitzung}`
			},
			body: JSON.stringify({ records: [rec("x")] })
		});
		expect(res.status).toBe(403);
	});
});

describe("Verwaltung", () => {
	function zumVerwalter(id: string) {
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
		zumVerwalter(ANNA);
		const res = await api(annaToken, "/api/admin/invites", {
			method: "POST",
			body: JSON.stringify({ note: "für Bodo", gueltigTage: 7 })
		});
		expect(res.status).toBe(201);
		const code = (await res.json()).code as string;
		// Vier Gruppen zu vier Zeichen - vorlesbar, ohne verwechselbare Zeichen.
		expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);

		const liste = await (await api(annaToken, "/api/admin/invites")).json();
		expect(liste.invites.some((i: { code: string }) => i.code === code)).toBe(true);
	});

	it("der ausgestellte Code oeffnet die Registrierung genau einmal", async () => {
		zumVerwalter(ANNA);
		const { code } = await (
			await api(annaToken, "/api/admin/invites", { method: "POST", body: "{}" })
		).json();

		const erste = await api(null, "/api/auth/register/start", {
			method: "POST",
			body: JSON.stringify({ displayName: "Neuling", invite: code })
		});
		expect(erste.status).toBe(200);

		// Entwertet wird erst beim Anlegen des Kontos - ein abgebrochener Versuch
		// darf die Einladung nicht verbrauchen.
		db.$client.prepare("UPDATE invites SET used_at = ?, used_by = ? WHERE code = ?").run(
			Date.now(),
			"irgendwer",
			code
		);
		const zweite = await api(null, "/api/auth/register/start", {
			method: "POST",
			body: JSON.stringify({ displayName: "Noch einer", invite: code })
		});
		expect(zweite.status).toBe(403);
	});

	it("ein zurueckgezogener Code gilt nicht mehr", async () => {
		zumVerwalter(ANNA);
		const { code } = await (
			await api(annaToken, "/api/admin/invites", { method: "POST", body: "{}" })
		).json();

		const weg = await api(annaToken, "/api/admin/invites", {
			method: "DELETE",
			body: JSON.stringify({ code })
		});
		expect(weg.status).toBe(200);

		const versuch = await api(null, "/api/auth/register/start", {
			method: "POST",
			body: JSON.stringify({ displayName: "Zu spät", invite: code })
		});
		expect(versuch.status).toBe(403);
	});

	it("ein abgelaufener Code gilt nicht mehr", async () => {
		zumVerwalter(ANNA);
		const { code } = await (
			await api(annaToken, "/api/admin/invites", { method: "POST", body: "{}" })
		).json();
		db.$client
			.prepare("UPDATE invites SET expires_at = ? WHERE code = ?")
			.run(Date.now() - 1000, code);

		const versuch = await api(null, "/api/auth/register/start", {
			method: "POST",
			body: JSON.stringify({ displayName: "Zu spät", invite: code })
		});
		expect(versuch.status).toBe(403);
	});

	it("meldet die Rolle in /api/me", async () => {
		expect((await (await api(annaToken, "/api/me")).json()).isAdmin).toBe(false);
		zumVerwalter(ANNA);
		expect((await (await api(annaToken, "/api/me")).json()).isAdmin).toBe(true);
	});

	it("ein Verwalter kommt trotzdem nicht an fremde Daten", async () => {
		zumVerwalter(ANNA);
		await api(bodoToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("b1")] })
		});
		// Die Rolle regelt, wer hereindarf - nicht, wer etwas sieht. Auch als
		// Verwalter sieht Anna ausschliesslich ihr eigenes Konto.
		const seite = await (await api(annaToken, "/api/sync?since=0")).json();
		expect(seite.records).toHaveLength(0);
		expect((await (await api(annaToken, "/api/me")).json()).userId).toBe(ANNA);
	});
});

/**
 * Eine Anfrage mit selbst gesetzter Host-Kopfzeile.
 *
 * `fetch` erlaubt das nicht - `host` gehoert zu den Koepfen, die der Client
 * nicht bestimmen darf, und undici setzt ihn auf die Zieladresse. Fuer die
 * Herkunftspruefung ist aber genau dieser Kopf der Vergleichspunkt.
 */
async function roheAnfrage(headers: Record<string, string>): Promise<number> {
	const { request } = await import("node:http");
	const rumpf = JSON.stringify({ records: [rec("roh")] });
	return new Promise<number>((auf, ab) => {
		const req = request(
			{
				hostname: "127.0.0.1",
				port: 5199,
				path: "/api/sync",
				method: "POST",
				headers: { "content-type": "application/json", "content-length": rumpf.length, ...headers }
			},
			(res) => {
				res.resume();
				res.on("end", () => auf(res.statusCode ?? 0));
			}
		);
		req.on("error", ab);
		req.end(rumpf);
	});
}

describe("Herkunft unter einem fremden Namen", () => {
	// ORIGIN sagt "localhost:5199". Jemand erreicht den Dienst aber ueber den
	// Rechnernamen im Heimnetz - und ist damit trotzdem auf der eigenen Seite.
	//
	// Der erste Anlauf verglich gegen event.url, und das baut adapter-node aus
	// ORIGIN zusammen. Damit war jeder ausgesperrt, der die Adresse anders tippte
	// als ORIGIN sie nennt.
	it("laesst durch, wenn Origin und Host zueinander passen", async () => {
		const sitzung = createSession(db, ANNA);
		// Mit `fetch` geht das nicht: die Host-Kopfzeile ist geschuetzt und wird
		// immer auf die tatsaechliche Zieladresse gesetzt. Genau die soll hier aber
		// eine andere sein - also von Hand.
		const res = await roheAnfrage({
			host: "tracker.fritz.box",
			origin: "http://tracker.fritz.box",
			cookie: `tt_session=${sitzung}`
		});
		expect(res).toBe(200);
	});

	it("weist ab, wenn Origin nicht zum Host passt", async () => {
		const sitzung = createSession(db, ANNA);
		const res = await fetch(`${base}/api/sync`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				host: "tracker.fritz.box",
				origin: "https://boeswillig.example",
				cookie: `tt_session=${sitzung}`
			},
			body: JSON.stringify({ records: [rec("x")] })
		});
		expect(res.status).toBe(403);
	});

	it("beruecksichtigt die weitergereichte Kopfzeile hinter einem Proxy", async () => {
		const sitzung = createSession(db, ANNA);
		const res = await fetch(`${base}/api/sync`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-forwarded-host": "tracker.example.de",
				origin: "https://tracker.example.de",
				cookie: `tt_session=${sitzung}`
			},
			body: JSON.stringify({ records: [rec("x")] })
		});
		expect(res.status).toBe(200);
	});
});
