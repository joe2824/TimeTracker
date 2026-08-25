// Was noch nicht beim Server ist.
//
// Die Outbox merkt sich NUR, WAS sich geaendert hat – Art, Id und bei Eintraegen
// der Monat – nie den Inhalt selbst. Den liest der Abgleich beim Hochladen aus
// den Dateien, die ohnehin die Wahrheit sind.
//
// Das ist kein Sparen um des Sparens willen: eine Outbox mit Inhalten waere eine
// zweite Kopie desselben Bestands, die auseinanderlaufen kann. Und sie stuende
// unverschluesselt auf der Platte, waehrend beim Server nur Chiffrat liegt.
//
// Ein Eintrag zu viel in der Outbox ist harmlos – er fuehrt dazu, dass ein
// unveraenderter Datensatz noch einmal hochgeladen wird. Ein fehlender waere ein
// Datensatz, der stillschweigend nie ankommt. Im Zweifel also lieber zu viel.
import type { Activity, Entry, Settings } from "../types";
import type { WriteHook } from "../store";
import { loadOutbox, saveOutbox, setWriteHook } from "../store";
import { diffAndStamp } from "./stamp";
import { logWarn } from "../log";

export type RecordKind = "entry" | "activity" | "settings";

/** Die Id des einen Einstellungs-Datensatzes – es gibt genau einen. */
export const SETTINGS_ID = "settings";

export interface PendingChange {
	kind: RecordKind;
	id: string;
	/** Nur bei Eintraegen: in welcher Monatsdatei der Datensatz liegt bzw. lag. */
	month?: string;
	deleted: boolean;
	/**
	 * Bei einer Loeschung: die Fassung, die der Datensatz zuletzt hatte.
	 *
	 * Ohne sie kaeme die Loeschung beim Server nie durch - er nimmt sie nur auf
	 * seiner aktuellen Fassung an, und die ist nach dem lokalen Loeschen nirgends
	 * mehr abzulesen.
	 */
	rev?: number;
	/** Wann die Aenderung bemerkt wurde (Epoch-ms). */
	at: number;
}

/** Schluessel, unter dem eine Aenderung eindeutig ist. */
function keyOf(c: Pick<PendingChange, "kind" | "id">): string {
	return `${c.kind}:${c.id}`;
}

/**
 * Mehrere Aenderungen am selben Datensatz zu einer zusammenfassen.
 *
 * Wer einen Eintrag anlegt, bearbeitet und wieder loescht, hinterlaesst genau
 * eine offene Aenderung: die Loeschung. Ohne das wuechse die Outbox mit jedem
 * Tastendruck im Eintrags-Dialog.
 */
export function mergePending(existing: PendingChange[], incoming: PendingChange[]): PendingChange[] {
	const byKey = new Map(existing.map((c) => [keyOf(c), c]));
	for (const c of incoming) byKey.set(keyOf(c), c);
	return [...byKey.values()];
}

let pending: PendingChange[] = [];
let loaded = false;
let deviceId = "";

/**
 * Waehrend der Abgleich Fremdes einspielt, wird nichts vorgemerkt.
 *
 * Ohne das frisst sich der Abgleich selbst: der Haken sieht das Einspielen wie
 * jede andere Aenderung, merkt sie vor, und der naechste Durchgang laedt sie
 * wieder hoch - wo sie als veraltet abgewiesen wird, weil der Server inzwischen
 * weiter ist. Das Ergebnis ist ein Geraet, das dauerhaft dieselben Datensaetze
 * im Kreis schickt und dabei staendig Konflikte meldet.
 *
 * Ein Zaehler statt eines Schalters: das Einspielen ruft geschachtelt.
 */
let suppressed = 0;

/**
 * Etwas schreiben, ohne es vorzumerken.
 *
 * Nur fuer das Einspielen von Serverdaten. Die Herkunftsspuren kommen dabei vom
 * Server und werden unveraendert durchgereicht - neu zu stempeln waere falsch,
 * es ist ja nicht die Aenderung dieses Geraets.
 */
export async function applyingRemote<T>(fn: () => Promise<T>): Promise<T> {
	suppressed++;
	try {
		return await fn();
	} finally {
		suppressed--;
	}
}

/** Ausstehende Aenderungen, aelteste zuerst. */
export function pendingChanges(): PendingChange[] {
	return [...pending].sort((a, b) => a.at - b.at);
}

/**
 * Aenderungen als erledigt abhaken.
 *
 * Ueber Schluessel statt ueber Indizes: zwischen Hochladen und Abhaken kann eine
 * neue Aenderung dazugekommen sein, und die darf nicht mit verschwinden.
 */
export async function clearChanges(done: Pick<PendingChange, "kind" | "id">[]): Promise<void> {
	const keys = new Set(done.map(keyOf));
	pending = pending.filter((c) => !keys.has(keyOf(c)));
	await persist();
}

async function persist(): Promise<void> {
	try {
		await saveOutbox(pending);
	} catch (e) {
		// Der Verlust ist verkraftbar: beim naechsten Start wird der gesamte
		// Bestand gegen den Server abgeglichen. Speichern darf daran nie scheitern.
		logWarn("Outbox konnte nicht gespeichert werden", e);
	}
}

/**
 * Wer erfahren will, dass etwas zu tun ist.
 *
 * Ein Rueckruf statt eines direkten Aufrufs: die Outbox soll nichts vom
 * Abgleich wissen. Andersherum waere es ein Kreis - der Abgleich schreibt ueber
 * den Haken in die Outbox, und die riefe ihn wieder auf.
 */
let onChange: (() => void) | null = null;

export function setChangeListener(fn: (() => void) | null): void {
	onChange = fn;
}

async function note(changes: PendingChange[]): Promise<void> {
	if (changes.length === 0) return;
	pending = mergePending(pending, changes);
	await persist();
	onChange?.();
}

/**
 * Den Abgleich scharf schalten.
 *
 * Ab hier bekommt jeder Schreibvorgang Herkunftsspuren und landet in der Outbox.
 * Vorher – und ohne verknuepftes Konto – passiert nichts davon.
 */
export async function startTracking(device: string): Promise<void> {
	deviceId = device;
	if (!loaded) {
		try {
			pending = await loadOutbox();
		} catch (e) {
			logWarn("Outbox nicht lesbar, beginne leer", e);
			pending = [];
		}
		loaded = true;
	}
	setWriteHook(hook);
}

/** Den Abgleich abschalten – das Programm verhaelt sich danach wieder rein lokal. */
export function stopTracking(): void {
	setWriteHook(null);
}

const hook: WriteHook = {
	async entries(month, before, after) {
		if (suppressed > 0) return after;
		const now = Date.now();
		const { changes, stamped } = diffAndStamp(before, after, deviceId, now);
		await note([
			...changes.changed.map((e: Entry) => ({ kind: "entry" as const, id: e.id, month, deleted: false, at: now })),
			...changes.deleted.map((e: Entry) => ({
				kind: "entry" as const,
				id: e.id,
				month,
				deleted: true,
				rev: e.rev,
				at: now
			}))
		]);
		return stamped;
	},

	async activities(before, after) {
		if (suppressed > 0) return after;
		const now = Date.now();
		const { changes, stamped } = diffAndStamp(before, after, deviceId, now);
		await note([
			...changes.changed.map((a: Activity) => ({ kind: "activity" as const, id: a.id, deleted: false, at: now })),
			...changes.deleted.map((a: Activity) => ({
				kind: "activity" as const,
				id: a.id,
				deleted: true,
				rev: a.rev,
				at: now
			}))
		]);
		return stamped;
	},

	async settings(before, after) {
		if (suppressed > 0) return after;
		const now = Date.now();
		// Die Einstellungen sind EIN Datensatz, kein Bestand – deshalb ueber eine
		// einelementige Liste mit fester Id statt ueber echte Identitaeten.
		const wrap = (s: Settings | null) => (s ? [{ ...s, id: SETTINGS_ID }] : []);
		const { changes, stamped } = diffAndStamp(wrap(before), wrap(after), deviceId, now);
		await note(changes.changed.map(() => ({ kind: "settings" as const, id: SETTINGS_ID, deleted: false, at: now })));
		// Die geliehene Id gehoert nicht in die Datei zurueck.
		const { id: _id, ...rest } = stamped[0];
		return rest as Settings;
	}
};

/** Nur fuer Tests: den Modulzustand vergessen. */
export function resetOutboxForTests(): void {
	onChange = null;
	pending = [];
	loaded = false;
	deviceId = "";
	suppressed = 0;
	setWriteHook(null);
}
