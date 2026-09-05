// Was die Tests rund um `AccountState` gemeinsam brauchen: ein nachgebauter
// Server hinter `globalThis.fetch`, ein sauberer Anfangszustand und das Warten,
// bis der Abgleich still liegt.
import { app } from "../app.svelte";
import { account } from "../sync/account.svelte";
import * as store from "../store";
import { resetOutboxForTests } from "../sync/outbox";
import { resetFakeFs } from "./fakeFs";
import { FakeSyncServer } from "./fakeSyncServer";

/** Das echte `fetch`, bevor der erste Nachbau sich davorgehaengt hat. */
let realFetch: typeof globalThis.fetch | null = null;

/**
 * Alles auf Anfang: leere Ablage, leere Merkliste, kein Zustand in `app` - und
 * ein frischer Nachbau hinter `globalThis.fetch`.
 */
export function freshAccountEnv(deviceId = "dieses-geraet"): FakeSyncServer {
	realFetch ??= globalThis.fetch;
	resetFakeFs();
	resetOutboxForTests();
	app.dispose();
	app.clearLocalData();
	const server = new FakeSyncServer();
	globalThis.fetch = server.fetchFor(deviceId);
	return server;
}

/**
 * Das echte `fetch` zurueckgeben.
 *
 * Symmetrisch zum Aufbau: geht ein Test unterwegs verloren, faenge der naechste
 * sonst den Nachbau des vorigen als "Original" ein.
 */
export function restoreFetch(): void {
	if (realFetch) globalThis.fetch = realFetch;
}

/**
 * Warten, bis nichts mehr offen ist.
 *
 * Das Verknuepfen stoesst selbst einen Abgleich an; laeuft der noch, kommt
 * `syncNow` sofort und ohne Wirkung zurueck. Zweimal derselbe Stand und nichts
 * mehr offen heisst: jetzt liegt alles still.
 */
export async function settled(): Promise<void> {
	let previous = -1;
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 3));
		await account.syncNow();
		const seq = (await store.loadDevice())?.seq ?? 0;
		if (account.pending === 0 && seq === previous) return;
		previous = seq;
	}
	throw new Error("Der Abgleich kam nicht zur Ruhe");
}

/** Warten, bis die Bedingung eintritt - laengstens eine Sekunde. */
export async function waitFor(cond: () => boolean | Promise<boolean>): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (await cond()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("Bedingung trat nicht ein");
}
