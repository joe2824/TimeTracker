// Was passiert, wenn eine Datensatzart hinzukommt, die es beim letzten Abgleich
// noch nicht gab.
//
// Der Stand `seq` laeuft ueber ALLES, was der Server hat. Eine Fassung, die eine
// Art nicht kennt, ueberspringt sie stillschweigend - und schiebt den Stand
// trotzdem weiter. Ohne einen einmaligen Nachlauf waeren die uebersprungenen
// Datensaetze fuer dieses Geraet dauerhaft unerreichbar.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSyncServer } from "../testing/fakeSyncServer";
import { freshAccountEnv, restoreFetch, settled } from "../testing/accountHarness";
import { files } from "../testing/fakeFs";
import type { ServerRecord } from "./api";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => import("../testing/toastStub"));

const { createVaultKey } = await import("../crypto/vault");
const { account, RESYNC_GENERATION } = await import("./account.svelte");
const store = await import("../store");
const { resetOutboxForTests } = await import("./outbox");
const { monthKey, shiftMonthKey } = await import("../time");

const MONTH = "2026-07";

const report = () => ({
	month: MONTH,
	importedAt: Date.UTC(2026, 6, 20),
	days: [{ date: `${MONTH}-15`, firstIn: "07:30", lastOut: "16:45", hours: 7.5, flags: [] }]
});


/**
 * Ein Geraet, das mit einer Fassung ohne Reports abgeglichen hat: der Report
 * liegt beim Server, der Stand steht dahinter, lokal gibt es nichts.
 */
async function asIfUpdatedFromOldVersion(): Promise<void> {
	const info = (await store.loadDevice())!;
	// Der Merker fehlt - genau so sieht eine Datei aus, die vor dem Nachlauf
	// geschrieben wurde.
	delete (info as { resyncGeneration?: number }).resyncGeneration;
	await store.saveDevice(info);
	// Die Datei direkt weg, nicht ueber deleteTimeReport: die alte Fassung kannte
	// diese Art gar nicht, sie hat also auch keinen Loeschmarker hinterlassen.
	files.delete(`data/timereport-${MONTH}.json`);
	resetOutboxForTests();
}

let server: FakeSyncServer;

beforeEach(() => {
	server = freshAccountEnv();
});

afterEach(restoreFetch);

describe("Monate beim Server", () => {
	it("erkennt aus den Kennungen, zu welchen Monaten es Daten gibt", async () => {
		// Waehrend der Backfill laeuft, liegt hier nur ein Teil. Die Auswahl zeigte
		// sonst ausgerechnet die Monate nicht, die man anklicken muesste.
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");
			await store.saveEntries("2026-07", [
				{ id: "e1", activityId: "a1", startTs: Date.UTC(2026, 6, 15, 9), endTs: Date.UTC(2026, 6, 15, 12), note: "", source: "manual" }
			]);
			await store.saveEntries("2026-04", [
				{ id: "e2", activityId: "a1", startTs: Date.UTC(2026, 3, 10, 9), endTs: Date.UTC(2026, 3, 10, 12), note: "", source: "manual" }
			]);
			await settled();

			const months = await account.remoteMonths();
			expect(months).toContain("2026-07");
			expect(months).toContain("2026-04");
			// Ein Monat ohne Daten steht nicht drin.
			expect(months).not.toContain("2026-05");
		} finally {
			restoreFetch();
			await account.unlink();
		}
	});

	it("findet auch einen Monat in der Zukunft", async () => {
		// Urlaub wird im Voraus gebucht - oft bis ins naechste Jahr. Die Liste
		// schaute nur zurueck; ein kuenftiger Monat von einem anderen Geraet fehlte
		// damit in der Auswahl, obwohl der Server Daten dazu hat.
		const future = shiftMonthKey(monthKey(Date.now()), 3);
		const [year, month] = future.split("-").map(Number);
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");
			await store.saveEntries(future, [
				{
					id: "e3",
					activityId: "a1",
					startTs: Date.UTC(year, month - 1, 10, 9),
					endTs: Date.UTC(year, month - 1, 10, 12),
					note: "",
					source: "manual"
				}
			]);
			await settled();

			expect(await account.remoteMonths()).toContain(future);
		} finally {
			restoreFetch();
			await account.unlink();
		}
	});

	it("liefert ohne Verknuepfung nichts, statt zu fragen", async () => {
		expect(await account.remoteMonths()).toEqual([]);
	});
});

describe("Erstes Verknuepfen", () => {
	it("behaelt die vorgezogenen Monate, statt sie dem Nachlauf zu opfern", async () => {
		// Der Nachlauf setzt den Stand auf 0 zurueck. Ein frisch verknuepftes Geraet
		// steht ohnehin auf 0 - ihm dabei die Prio-Monate zu nehmen, haette den
		// gestuften Abruf bei JEDER Erstverknuepfung abgeschaltet.
		server.hold();
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");

			expect((await store.loadDevice())!.priority?.months).toContain(monthKey(Date.now()));
			expect(account.backfilling).toBe(true);
			// Frisch verknuepft: hier fehlt wirklich alles Aeltere.
			expect(account.historyIncomplete).toBe(true);
		} finally {
			server.release();
			restoreFetch();
			await account.unlink();
		}
	});
});

describe("Monat auf Zuruf", () => {
	it("nennt den Monat, solange er geholt wird", async () => {
		// Die Auswahl zeigt dazu einen Spinner. Ohne diese Angabe sieht ein Klick
		// auf einen alten Monat bei schlechter Verbindung nach "nichts passiert"
		// aus - dabei laeuft der Abruf gerade.
		const old = "2020-03";
		server.hold();
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");
			expect(account.fetchingMonths).not.toContain(old);

			const running = account.ensureMonthSynced(old);
			await Promise.resolve();
			expect(account.fetchingMonths).toContain(old);

			server.release();
			await running;
			expect(account.fetchingMonths).not.toContain(old);
		} finally {
			server.release();
			restoreFetch();
			await account.unlink();
		}
	});

	it("meldet nichts, wenn der Monat ohnehin schon da ist", async () => {
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");
			// Der laufende Monat ist vorgezogen - da gibt es nichts nachzuholen.
			await account.ensureMonthSynced(monthKey(Date.now()));
			expect(account.fetchingMonths).toEqual([]);
		} finally {
			restoreFetch();
			await account.unlink();
		}
	});
});

describe("Nachlauf fuer eine neue Datensatzart", () => {
	it("holt den uebersprungenen Report nach dem Update nach", async () => {
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");
			await store.saveTimeReport(report());
			await settled();
			expect(server.rows.has(`timereport:${MONTH}`)).toBe(true);

			const seqBefore = (await store.loadDevice())!.seq;
			expect(seqBefore).toBeGreaterThan(0);

			await asIfUpdatedFromOldVersion();
			expect(await store.loadTimeReport(MONTH)).toBeNull();

			const seqBeforeUpdate = server.seq;
			await account.init();
			await settled();

			// Der Nachlauf HOLT - er schiebt nicht. Der zurueckgesetzte Stand darf
			// nicht als "frisch verknuepft" durchgehen, sonst ginge der ganze
			// Bestand ohne Not noch einmal hoch und jedes andere Geraet zoege ihn
			// hinter einer neuen Fassung wieder herunter.
			expect(server.seq).toBe(seqBeforeUpdate);

			// Ohne den Nachlauf bliebe der Stand stehen und der Report fuer immer weg.
			expect(await store.loadTimeReport(MONTH)).not.toBeNull();
			expect((await store.loadDevice())!.resyncGeneration).toBe(RESYNC_GENERATION);
		} finally {
			restoreFetch();
			await account.unlink();
		}
	});

	it("laesst dem Geraet mitten im Backfill die vorgezogenen Monate", async () => {
		// Stand > 0 UND vorgezogene Monate heisst: die Historie fehlt hier noch
		// zum Teil. Nimmt der Nachlauf ihm den vorgezogenen Teil, laeuft der
		// Abruf wieder aeltestes zuerst - und `backfilling` faellt auf false,
		// obwohl Monate fehlen. Damit gehen die Sperren fuer Sicherung und
		// Monatsauswahl still auf, und eine Teilsicherung traegt "vollstaendig".
		server.hold();
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");
			const info = (await store.loadDevice())!;
			delete (info as { resyncGeneration?: number }).resyncGeneration;
			await store.saveDevice({
				...info,
				seq: 42,
				priority: { seq: 17, months: [monthKey(Date.now())] }
			});

			await account.init();

			const after = (await store.loadDevice())!;
			expect(after.seq).toBe(0);
			expect(after.priority?.months).toContain(monthKey(Date.now()));
			// Der eigene Stand des vorgezogenen Teils muss genauso zurueck, sonst
			// zeigt er hinter die Datensaetze, die der Nachlauf gerade erst holt.
			expect(after.priority?.seq).toBe(0);
			expect(account.backfilling).toBe(true);
		} finally {
			server.release();
			restoreFetch();
			await account.unlink();
		}
	});

	it("gibt einem Geraet ohne vorgezogenen Teil einen", async () => {
		// Verknuepft, bevor es den gestuften Abruf gab: Stand > 0, kein
		// vorgezogener Teil. Der Nachlauf setzt den Stand auf 0 - ohne Prio-Monate
		// kaeme danach die ganze Historie aeltestes zuerst, der aktuelle Monat
		// zuletzt, und davor stuende das Modal.
		server.hold();
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");
			const info = (await store.loadDevice())!;
			delete (info as { resyncGeneration?: number }).resyncGeneration;
			await store.saveDevice({ ...info, seq: 42, priority: undefined });

			await account.init();

			const after = (await store.loadDevice())!;
			expect(after.seq).toBe(0);
			expect(after.priority?.months).toContain(monthKey(Date.now()));
			expect(after.priority?.seq).toBe(0);
			// Sein Stand stand auf 42: die Monate liegen hier, der Nachlauf holt sie
			// nur noch einmal. Die Sicherung zu sperren waere Fehlalarm.
			expect(after.priority?.historyLocal).toBe(true);
			expect(account.backfilling).toBe(true);
			expect(account.historyIncomplete).toBe(false);
		} finally {
			server.release();
			restoreFetch();
			await account.unlink();
		}
	});

	it("holt beim naechsten Start nicht noch einmal alles", async () => {
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");
			await store.saveTimeReport(report());
			await settled();

			expect((await store.loadDevice())!.seq).toBeGreaterThan(0);

			// Ab hier zaehlt, womit der zweite Start abruft.
			server.pulledSince = [];
			resetOutboxForTests();
			await account.init();
			await settled();

			// Kein Abruf ab 0: der Merker steht schon, der Nachlauf ist erledigt.
			expect(server.pulledSince.length).toBeGreaterThan(0);
			expect(server.pulledSince).not.toContain(0);
		} finally {
			restoreFetch();
			await account.unlink();
		}
	});
});
