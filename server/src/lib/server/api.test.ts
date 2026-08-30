// Durchstich durch die Endpunkte - gegen einen echten Server, ueber echtes HTTP.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db";
import { users } from "./db/schema";
import { createDevice, createSession, hashSecret, sha256Hex } from "./auth";
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

/** Anfrage aus einer eigenen Adresse - so verbraucht kein Test den Vorrat des naechsten. */
let adressZaehler = 0;
function apiVon(token: string | null, path: string, init: RequestInit = {}) {
	adressZaehler++;
	return api(token, path, {
		...init,
		headers: { "x-echte-adresse": `10.0.0.${adressZaehler}`, ...(init.headers ?? {}) }
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
	process.env.ORIGIN = "http://localhost:5199";
	process.env.RP_ID = "localhost";
	process.env.ALLOWED_ORIGINS = "http://localhost:5199";
	// Damit jeder Test seinen eigenen Bremseimer bekommen kann - siehe `apiVon`.
	process.env.ADDRESS_HEADER = "x-echte-adresse";
	// Kurz halten: sonst haengt jeder Wartetest 25 Sekunden.
	process.env.SYNC_WAIT_MS = "800";

	db = openDb(dbFile).db;

	// Den gebauten Server starten. Er liest DB_FILE aus der Umgebung und oeffnet
	// dieselbe Datei - beide Seiten sehen damit denselben Bestand.
	// Der GEBAUTE Server, nicht die Quellen: nur so ist geprueft, was spaeter
	// wirklich laeuft - samt Adapter, Kompilat und Aufloesung der Abhaengigkeiten.
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
		const frueh = await (
			await api(null, "/api/pair/claim", {
				method: "POST",
				body: claimBody(start.code)
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
		await apiVon(null, "/api/pair/start", { method: "POST", body: startBody("cHVi", "Handy", code) });
		await api(annaToken, "/api/pair/approve", {
			method: "POST",
			body: JSON.stringify({ code, wrappedKey: "cGFrZXQ=" })
		});

		// Nur der Code - wie ihn jemand vom Bildschirm ablesen koennte.
		const ohne = await apiVon(null, "/api/pair/claim", {
			method: "POST",
			body: JSON.stringify({ code })
		});
		expect(ohne.status).toBe(404);

		// Und das Paket liegt noch da: der Fehlgriff hat den Vorgang nicht verbraucht.
		const echt = await (
			await apiVon(null, "/api/pair/claim", { method: "POST", body: claimBody(code) })
		).json();
		expect(echt.pending).toBe(false);
		expect(echt.wrappedKey).toBe("cGFrZXQ=");
	});

	it("weist ein falsches Abhol-Geheimnis wie einen unbekannten Code ab", async () => {
		// 404, nicht 403: eine eigene Antwort verriete, dass es diesen Vorgang
		// gibt. So sieht Raten aus wie Raten - und die Bremse zaehlt es als
		// Fehlgriff (siehe hooks.server.ts).
		const code = "DDDDEEEEFFFF";
		await apiVon(null, "/api/pair/start", { method: "POST", body: startBody("cHVi", "Handy", code) });
		const falsch = await apiVon(null, "/api/pair/claim", {
			method: "POST",
			body: claimBody(code, "danebengeraten")
		});
		expect(falsch.status).toBe(404);
	});

	it("laesst kein fremdes Abhol-Geheimnis nachschieben", async () => {
		// Der oeffentliche Schluessel ist ueber /api/pair/approve abfragbar. Wer ihn
		// samt Code hat, duerfte sonst mit einem eigenen Geheimnis noch einmal
		// starten und dem echten Geraet das Token wegnehmen.
		const code = "GGGGHHHHJJJJ";
		await apiVon(null, "/api/pair/start", { method: "POST", body: startBody("cHVi", "Handy", code) });

		const fremd = await apiVon(null, "/api/pair/start", {
			method: "POST",
			body: startBody("cHVi", "Handy", code, sha256Hex("meins"))
		});
		expect(fremd.status).toBe(409);

		// Das echte Geheimnis gilt weiterhin.
		await api(annaToken, "/api/pair/approve", {
			method: "POST",
			body: JSON.stringify({ code, wrappedKey: "cGFrZXQ=" })
		});
		const echt = await (
			await apiVon(null, "/api/pair/claim", { method: "POST", body: claimBody(code) })
		).json();
		expect(echt.pending).toBe(false);
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
		const r = await apiVon(null, "/api/pair/start", {
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

		const fremd = await api(null, "/api/pair/start", {
			method: "POST",
			body: startBody("ZmFsc2No", "Untergeschoben", code)
		});
		expect(fremd.status).toBe(409);

		// Und der echte Schluessel steht noch da.
		const gesehen = await (await api(annaToken, `/api/pair/approve?code=${code}`)).json();
		expect(gesehen.publicKey).toBe("ZWNodA==");
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

describe("Warteschleife statt Ereigniskanal", () => {
	it("kommt sofort zurueck, wenn der Server schon weiter ist", async () => {
		await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("e1")] })
		});

		const begonnen = Date.now();
		const antwort = await api(annaToken, "/api/sync/wait?since=0");
		const daten = await antwort.json();

		expect(antwort.status).toBe(200);
		expect(daten.changed).toBe(true);
		expect(daten.seq).toBeGreaterThan(0);
		// Nicht gewartet: sonst verpasst ein Client jede Aenderung, die zwischen
		// seinem Abgleich und dieser Anfrage passiert ist.
		expect(Date.now() - begonnen).toBeLessThan(1000);
	});

	it("haelt offen und antwortet, sobald geschrieben wird", async () => {
		const stand = await (await api(annaToken, "/api/sync/wait?since=0")).json().catch(() => null);
		const seit = stand?.seq ?? 0;

		const wartet = api(annaToken, `/api/sync/wait?since=${seit}`);
		// Erst schreiben, wenn die Anfrage wirklich haengt - sonst faengt sie der
		// Schnellweg oben ab und der Test prueft nichts.
		await new Promise((r) => setTimeout(r, 150));
		await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("e2")] })
		});

		const daten = await (await wartet).json();
		expect(daten.changed).toBe(true);
		expect(daten.seq).toBeGreaterThan(seit);
	});

	it("weckt nicht bei der Aenderung eines fremden Kontos", async () => {
		const seit = (await (await api(bodoToken, "/api/sync/wait?since=0")).json()).seq;
		const wartet = api(bodoToken, `/api/sync/wait?since=${seit}`);
		await new Promise((r) => setTimeout(r, 150));
		await api(annaToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("annas")] })
		});

		// Sie kommt nach Ablauf der Wartezeit zurueck - aber ohne Aenderung.
		expect((await (await wartet).json()).changed).toBe(false);
	});

	it("verlangt eine Anmeldung", async () => {
		expect((await fetch(`${base}/api/sync/wait?since=0`)).status).toBe(401);
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
		const gestartet = await api(null, "/api/pair/start", {
			method: "POST",
			body: startBody("AAAA", "Wartendes Gerät", code)
		});
		expect(gestartet.status).toBe(200);

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
		let gebremst = false;
		for (let i = 0; i < 40; i++) {
			const res = await api(null, "/api/pair/claim", {
				method: "POST",
				body: JSON.stringify({ code: `RATEVERSUCH${i}` })
			});
			if (res.status === 429) {
				gebremst = true;
				break;
			}
		}
		expect(gebremst).toBe(true);
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

	it("laesst statische Einladungscodes per PATCH deaktivieren und aktivieren", async () => {
		zumVerwalter(ANNA);
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
		zumVerwalter(ANNA);
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
		zumVerwalter(ANNA);
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

describe("Passkeys verwalten", () => {
	/** Einen Passkey direkt eintragen - ohne Authentifikator geht es nicht anders. */
	function legePasskeyAn(userId: string, id: string, label: string | null = null) {
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
		legePasskeyAn(ANNA, "annas-schluessel", "Annas Laptop");
		legePasskeyAn(BODO, "bodos-schluessel", "Bodos Handy");

		const { passkeys } = await (await api(annaToken, "/api/passkeys")).json();
		expect(passkeys).toHaveLength(1);
		expect(passkeys[0].label).toBe("Annas Laptop");
	});

	it("schliesst beim Anlegen die vorhandenen aus", async () => {
		// Sonst legt derselbe Authentifikator einen zweiten Passkey fuer dasselbe
		// Konto an - und der Mensch glaubt, er haette jetzt zwei Wege, obwohl beide
		// an demselben Geraet haengen.
		legePasskeyAn(ANNA, "schon-da");
		const { options } = await (
			await api(annaToken, "/api/passkeys/start", { method: "POST" })
		).json();
		expect(options.excludeCredentials.map((c: { id: string }) => c.id)).toContain("schon-da");
	});

	it("laesst sich umbenennen", async () => {
		legePasskeyAn(ANNA, "annas-schluessel", "Alt");
		const res = await api(annaToken, "/api/passkeys", {
			method: "PATCH",
			body: JSON.stringify({ id: "annas-schluessel", label: "Der alte Rechner" })
		});
		expect(res.status).toBe(200);
		const { passkeys } = await (await api(annaToken, "/api/passkeys")).json();
		expect(passkeys[0].label).toBe("Der alte Rechner");
	});

	it("laesst KEINEN fremden umbenennen", async () => {
		legePasskeyAn(BODO, "bodos-schluessel", "Bodos Handy");
		const res = await api(annaToken, "/api/passkeys", {
			method: "PATCH",
			body: JSON.stringify({ id: "bodos-schluessel", label: "gekapert" })
		});
		expect(res.status).toBe(404);
	});

	it("entfernt einen von mehreren - samt seiner Verpackung", async () => {
		legePasskeyAn(ANNA, "alter-rechner", "Alter Rechner");
		legePasskeyAn(ANNA, "neues-handy", "Neues Handy");
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
		legePasskeyAn(ANNA, "der-einzige", "Der einzige");
		const res = await api(annaToken, "/api/passkeys", {
			method: "DELETE",
			body: JSON.stringify({ id: "der-einzige" })
		});
		expect(res.status).toBe(409);

		const { passkeys } = await (await api(annaToken, "/api/passkeys")).json();
		expect(passkeys).toHaveLength(1);
	});

	it("laesst KEINEN fremden entfernen", async () => {
		legePasskeyAn(ANNA, "annas-eigener");
		legePasskeyAn(BODO, "bodos-erster");
		legePasskeyAn(BODO, "bodos-zweiter");

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
	function einladung(): string {
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
			body: JSON.stringify({ displayName: "x".repeat(200), label: "R", invite: einladung() })
		});
		expect(res.status).toBe(400);
	});

	it("legt Konto und Geraet in einem Zug an", async () => {
		const res = await api(null, "/api/auth/device", {
			method: "POST",
			body: JSON.stringify({ displayName: "Neuling", label: "Neulings Rechner", invite: einladung() })
		});
		expect(res.status).toBe(200);
		const { userId, deviceToken } = await res.json();
		expect(deviceToken).toBeTruthy();

		// Das Token traegt sofort - ohne das waere das Konto unerreichbar, denn
		// einen Passkey gibt es hier nicht.
		const ich = await (await api(deviceToken, "/api/me")).json();
		expect(ich.userId).toBe(userId);
		expect(ich.displayName).toBe("Neuling");
		expect(ich.passkeys).toHaveLength(0);
		expect(ich.devices).toHaveLength(1);
	});

	it("kann sofort abgleichen", async () => {
		// Der eigentliche Zweck: die Daten liegen auf diesem Rechner und sollen
		// hoch. Ein Konto, das erst noch einen Passkey braucht, waere ein Umweg.
		const { deviceToken } = await (
			await api(null, "/api/auth/device", {
				method: "POST",
				body: JSON.stringify({ displayName: "Neuling", label: "Rechner", invite: einladung() })
			})
		).json();

		const hoch = await api(deviceToken, "/api/sync", {
			method: "POST",
			body: JSON.stringify({ records: [rec("e1"), rec("e2")] })
		});
		expect(hoch.status).toBe(200);
		expect((await hoch.json()).accepted).toHaveLength(2);
	});

	it("nimmt die Verpackung der Phrase an", async () => {
		const { deviceToken } = await (
			await api(null, "/api/auth/device", {
				method: "POST",
				body: JSON.stringify({ displayName: "Neuling", label: "Rechner", invite: einladung() })
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
		const ich = await (await api(deviceToken, "/api/me")).json();
		expect(ich.devices[0].label).toBe("Rechner");
	});
});

describe("Wiederherstellung mit der Phrase", () => {
	/** Kennung und Nachweis hinterlegen - genau so, wie die Anwendung es tut. */
	function legeAb(token: string, felder: Record<string, unknown>) {
		return api(token, "/api/wraps", {
			method: "POST",
			body: JSON.stringify({ kind: "recovery", payload: "verpacktes-chiffrat", ...felder })
		});
	}

	function konto(id: string) {
		return db.$client.prepare("SELECT recovery_id, vault_proof FROM users WHERE id = ?").get(id) as {
			recovery_id: string | null;
			vault_proof: string | null;
		};
	}

	function zaehleWraps(id: string) {
		return (
			db.$client
				.prepare("SELECT count(*) AS n FROM key_wraps WHERE user_id = ?")
				.get(id) as { n: number }
		).n;
	}

	it("gibt die Verpackung zu einer bekannten Kennung heraus", async () => {
		await legeAb(annaToken, { recoveryId: "kennung-anna", vaultProof: "beweis-anna" });
		const res = await apiVon(null, "/api/auth/recover", {
			method: "POST",
			body: JSON.stringify({ recoveryId: "kennung-anna" })
		});
		expect(res.status).toBe(200);
		expect((await res.json()).wrap).toBe("verpacktes-chiffrat");
	});

	it("verraet nicht, ob es ein Konto gibt", async () => {
		// Dieselbe Meldung fuer "kenne ich nicht" und "hat keine Verpackung" -
		// sonst laesst sich durchprobieren, welche Konten existieren.
		const res = await apiVon(null, "/api/auth/recover", {
			method: "POST",
			body: JSON.stringify({ recoveryId: "gibt-es-nicht" })
		});
		expect(res.status).toBe(404);
	});

	it("gibt OHNE Nachweis kein Geraete-Token", async () => {
		// Der Kern: wer die Kennung aus einer gestohlenen Datenbank abliest,
		// bekommt die Verpackung - die er nicht oeffnen kann - und sonst nichts.
		await legeAb(annaToken, { recoveryId: "kennung-anna", vaultProof: "beweis-anna" });
		const res = await apiVon(null, "/api/auth/recover", {
			method: "POST",
			body: JSON.stringify({ recoveryId: "kennung-anna" })
		});
		const antwort = await res.json();
		expect(antwort.deviceToken).toBeUndefined();
		expect(antwort.wrap).toBeTruthy();
	});

	it("weist einen falschen Nachweis ab", async () => {
		await legeAb(annaToken, { recoveryId: "kennung-anna", vaultProof: "beweis-anna" });
		const res = await apiVon(null, "/api/auth/recover", {
			method: "POST",
			body: JSON.stringify({ recoveryId: "kennung-anna", proof: "erfunden", label: "Neu" })
		});
		expect(res.status).toBe(401);
	});

	it("meldet mit richtigem Nachweis ein Geraet an", async () => {
		await legeAb(annaToken, { recoveryId: "kennung-anna", vaultProof: "beweis-anna" });
		const res = await apiVon(null, "/api/auth/recover", {
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
		const ich = await (await api(deviceToken, "/api/me")).json();
		expect(ich.userId).toBe(ANNA);
		expect(ich.devices.some((d: { label: string }) => d.label === "Neuer Rechner")).toBe(true);
	});

	it("fuehrt nicht zu einem fremden Konto", async () => {
		await legeAb(annaToken, { recoveryId: "kennung-anna", vaultProof: "beweis-anna" });
		await legeAb(bodoToken, { recoveryId: "kennung-bodo", vaultProof: "beweis-bodo" });
		const res = await apiVon(null, "/api/auth/recover", {
			method: "POST",
			body: JSON.stringify({ recoveryId: "kennung-anna", proof: "beweis-bodo", label: "X" })
		});
		expect(res.status).toBe(401);
	});

	it("legt den Nachweis nur als Hash ab", async () => {
		// Sonst genuegte ein Datenbankabzug: abschreiben, zurueckschicken, Token.
		await legeAb(annaToken, { recoveryId: "kennung-anna", vaultProof: "beweis" });
		expect(konto(ANNA).vault_proof).toBe(hashSecret("beweis"));
	});

	it("nimmt Kennung und Nachweis nur zusammen an", async () => {
		// Eines allein wuerde das andere ueberschreiben.
		await legeAb(annaToken, { recoveryId: "kennung-anna", vaultProof: "beweis" });
		expect((await legeAb(annaToken, { recoveryId: "andere-kennung" })).status).toBe(400);
		expect((await legeAb(annaToken, { vaultProof: "anderer-beweis" })).status).toBe(400);
		expect(konto(ANNA)).toEqual({ recovery_id: "kennung-anna", vault_proof: hashSecret("beweis") });
	});

	it("weist eine bereits vergebene Kennung ab - und schreibt dabei nichts", async () => {
		await legeAb(annaToken, { recoveryId: "kennung-anna", vaultProof: "beweis-anna" });
		const res = await legeAb(bodoToken, { recoveryId: "kennung-anna", vaultProof: "beweis-bodo" });
		expect(res.status).toBe(409);
		// Der Abbruch nimmt alles mit: keine halbe Zeile, keine Verpackung.
		expect(konto(BODO)).toEqual({ recovery_id: null, vault_proof: null });
		expect(zaehleWraps(BODO)).toBe(0);
	});

	it("laesst eine neue Phrase die alte ersetzen", async () => {
		await legeAb(annaToken, { recoveryId: "kennung-alt", vaultProof: "beweis-alt" });
		await legeAb(annaToken, { recoveryId: "kennung-neu", vaultProof: "beweis-neu" });
		expect(zaehleWraps(ANNA)).toBe(1);
		const alt = await apiVon(null, "/api/auth/recover", {
			method: "POST",
			body: JSON.stringify({ recoveryId: "kennung-alt" })
		});
		expect(alt.status).toBe(404);
	});

	it("bremst das Durchprobieren des Nachweises", async () => {
		// Eine feste Adresse fuer alle Versuche - die Bremse zaehlt je Aufrufer.
		await legeAb(annaToken, { recoveryId: "kennung-anna", vaultProof: "beweis-anna" });
		let gebremst = false;
		for (let i = 0; i < 30 && !gebremst; i++) {
			const res = await api(null, "/api/auth/recover", {
				method: "POST",
				headers: { "x-echte-adresse": "10.9.9.9" },
				body: JSON.stringify({ recoveryId: "kennung-anna", proof: `versuch-${i}`, label: "X" })
			});
			gebremst = res.status === 429;
			if (gebremst) expect(res.headers.get("retry-after")).toBeTruthy();
		}
		expect(gebremst).toBe(true);
	});
});
