// Wann abgeglichen wird - und in welcher Reihenfolge.
//
// Der Ablauf ist immer derselbe:
//   1. Hochladen, was offen ist (aus der Outbox)
//   2. Herunterladen, was seit dem letzten Mal dazukam
//   3. Zusammenfuehren und lokal anwenden
//   4. Bei Konflikten: zurueck zu 1, jetzt auf dem neuen Serverstand
//
// Erst hochladen, dann herunterladen: andersherum wuerde ein gerade
// heruntergeladener Stand die eigene, noch nicht hochgeladene Aenderung
// ueberschreiben, bevor sie je beim Server war.
import type { Entry, Activity, Settings } from "../types";
import { Api, ApiError, type OutgoingRecord, type ServerRecord } from "./api";
import {
	applyingRemote,
	clearChanges,
	pendingChanges,
	SETTINGS_ID,
	type PendingChange
} from "./outbox";
import { mergeRecord, resolveOpenEntries } from "./merge";
import {
	bucketFor,
	fromBase64,
	openRecord,
	sealRecord,
	toBase64,
	type Sealed
} from "../crypto/vault";
import { logError, logInfo, logWarn } from "../log";
import { monthKey } from "../time";

/** Wie oft nach einem Konflikt neu versucht wird, bevor aufgegeben wird. */
const MAX_ROUNDS = 5;
/** Datensaetze je Anfrage - der Server nimmt hoechstens 500. */
const BATCH = 200;

export interface LocalStore {
	entriesOfMonth(month: string): Promise<Entry[]>;
	saveEntries(month: string, entries: Entry[]): Promise<void>;
	activities(): Promise<Activity[]>;
	saveActivities(list: Activity[]): Promise<void>;
	settings(): Promise<Settings>;
	saveSettings(s: Settings): Promise<void>;
}

export interface SyncState {
	/** Bis zu welchem Serverstand dieses Geraet alles kennt. */
	seq: number;
}

export interface SyncOutcome {
	pushed: number;
	pulled: number;
	/** Wie oft eine eigene, noch nicht hochgeladene Aenderung unterlegen ist. */
	lostEdits: number;
	seq: number;
}

/**
 * Das Chiffrat samt Zufallswert als eine Zeichenkette.
 *
 * Beides gehoert zusammen und reist zusammen; getrennte Felder waeren zwei
 * Gelegenheiten, eines davon zu vergessen.
 */
function packSealed(sealed: Sealed): string {
	const out = new Uint8Array(sealed.iv.length + sealed.ciphertext.length);
	out.set(sealed.iv);
	out.set(sealed.ciphertext, sealed.iv.length);
	return toBase64(out);
}

function unpackSealed(payload: string): Sealed {
	const raw = fromBase64(payload);
	return { iv: raw.slice(0, 12), ciphertext: raw.slice(12) };
}

/**
 * Was von einem Eintrag verschluesselt wird.
 *
 * Die Herkunftsspuren bleiben draussen: sie stehen im Klartext daneben, weil der
 * Server die Reihenfolge braucht. Sie ein zweites Mal mitzuverschluesseln waere
 * eine Quelle fuer Widersprueche zwischen beiden Fassungen.
 */
function contentOf<T extends { updatedAt?: number; rev?: number; deviceId?: string }>(
	item: T
): Omit<T, "updatedAt" | "rev" | "deviceId"> {
	const { updatedAt: _u, rev: _r, deviceId: _d, ...rest } = item;
	return rest;
}

export class SyncEngine {
	#api: Api;
	#key: CryptoKey;
	#store: LocalStore;
	#deviceId: string;
	#state: SyncState;
	#saveState: (s: SyncState) => Promise<void>;
	/** Laeuft gerade ein Durchgang? Zwei gleichzeitig wuerden sich ins Gehege kommen. */
	#running = false;
	/** Kam waehrend eines Durchgangs eine Anforderung? Dann gleich noch einmal. */
	#again = false;

	constructor(opts: {
		api: Api;
		key: CryptoKey;
		store: LocalStore;
		deviceId: string;
		state: SyncState;
		saveState: (s: SyncState) => Promise<void>;
	}) {
		this.#api = opts.api;
		this.#key = opts.key;
		this.#store = opts.store;
		this.#deviceId = opts.deviceId;
		this.#state = opts.state;
		this.#saveState = opts.saveState;
	}

	get seq(): number {
		return this.#state.seq;
	}

	/**
	 * Einen Durchgang anstossen.
	 *
	 * Laeuft schon einer, wird gemerkt, dass danach gleich der naechste faellig
	 * ist - statt einen zweiten danebenzustellen. Ohne das wuerden mehrere
	 * Durchgaenge sich gegenseitig die Outbox unter den Fuessen wegziehen.
	 */
	async sync(): Promise<SyncOutcome | null> {
		if (this.#running) {
			this.#again = true;
			return null;
		}
		this.#running = true;
		try {
			let outcome = await this.#round();
			while (this.#again) {
				this.#again = false;
				const weiter = await this.#round();
				outcome = {
					pushed: outcome.pushed + weiter.pushed,
					pulled: outcome.pulled + weiter.pulled,
					lostEdits: outcome.lostEdits + weiter.lostEdits,
					seq: weiter.seq
				};
			}
			return outcome;
		} finally {
			this.#running = false;
			this.#again = false;
		}
	}

	async #round(): Promise<SyncOutcome> {
		const pushed = await this.#pushAll();
		const { pulled, lostEdits } = await this.#pullAll();
		return { pushed, pulled, lostEdits, seq: this.#state.seq };
	}

	// ---------- Hochladen ----------

	async #pushAll(): Promise<number> {
		let gesamt = 0;
		for (let runde = 0; runde < MAX_ROUNDS; runde++) {
			const offen = pendingChanges();
			if (offen.length === 0) break;

			const stapel = offen.slice(0, BATCH);
			const records = await this.#toOutgoing(stapel);
			if (records.length === 0) {
				// Nichts Verwertbares dabei - etwa lauter Aenderungen an Datensaetzen,
				// die es lokal nicht mehr gibt. Abhaken, sonst dreht sich die Schleife
				// bis MAX_ROUNDS um nichts.
				await clearChanges(stapel);
				continue;
			}

			const antwort = await this.#api.push(records);
			gesamt += antwort.accepted.length;

			// Nur das Angenommene abhaken. Was im Konflikt steckt, bleibt offen und
			// geht in die naechste Runde - dann auf dem inzwischen bekannten Stand.
			const angenommen = new Set(antwort.accepted.map((a) => a.id));
			await clearChanges(stapel.filter((c) => angenommen.has(c.id)));

			if (antwort.conflicts.length > 0) {
				// Die Konflikte aufloesen heisst: den Serverstand holen und
				// zusammenfuehren. Danach steht die Aenderung auf der richtigen
				// Fassung und kommt in der naechsten Runde durch.
				await this.#pullAll();
				continue;
			}
			if (stapel.length === offen.length) break;
		}
		return gesamt;
	}

	async #toOutgoing(changes: PendingChange[]): Promise<OutgoingRecord[]> {
		const out: OutgoingRecord[] = [];
		// Die Monatsdateien einmal lesen statt je Aenderung: ein Tag mit zwanzig
		// Eintraegen laege sonst zwanzigmal auf dem Tisch.
		const monate = new Map<string, Entry[]>();
		const monatVon = async (m: string) => {
			if (!monate.has(m)) monate.set(m, await this.#store.entriesOfMonth(m));
			return monate.get(m)!;
		};
		let aktivitaeten: Activity[] | null = null;

		for (const c of changes) {
			try {
				if (c.kind === "entry") {
					const liste = await monatVon(c.month ?? "");
					const eintrag = liste.find((e) => e.id === c.id);
					out.push(await this.#record(c, eintrag, eintrag ? monthKey(eintrag.startTs) : c.month));
				} else if (c.kind === "activity") {
					aktivitaeten ??= await this.#store.activities();
					out.push(await this.#record(c, aktivitaeten.find((a) => a.id === c.id)));
				} else {
					out.push(await this.#record(c, { ...(await this.#store.settings()), id: SETTINGS_ID }));
				}
			} catch (e) {
				// Ein einzelner Datensatz, der sich nicht verpacken laesst, darf den
				// ganzen Abgleich nicht anhalten.
				logWarn(`Datensatz ${c.kind}/${c.id} konnte nicht vorbereitet werden`, e);
			}
		}
		return out;
	}

	async #record(
		change: PendingChange,
		item: ({ id: string } & { updatedAt?: number; rev?: number; deviceId?: string }) | undefined,
		month?: string
	): Promise<OutgoingRecord> {
		const bucket = month ? await bucketFor(this.#key, month) : null;
		// Ob geloescht wurde, sagt die Outbox - nicht das Fehlen des Datensatzes.
		//
		// Der Unterschied zaehlt: zwischen Vormerken und Hochladen kann ein
		// Abgleich den Datensatz vom Server zurueckgeholt haben. Wuerde hier auf
		// "ist da, also geaendert" geschlossen, ginge die Loeschung dabei still
		// verloren und der Eintrag kaeme immer wieder.
		if (change.deleted || !item) {
			return {
				id: change.id,
				kind: change.kind,
				bucket,
				// Die Fassung aus der Outbox; nur wenn auch die fehlt, faellt es auf
				// "gab es beim Server noch nie" zurueck.
				baseRev: change.rev ?? item?.rev ?? 0,
				updatedAt: change.at,
				deletedAt: change.at
			};
		}
		const rev = item.rev ?? 0;
		const sealed = await sealRecord(this.#key, contentOf(item), {
			id: item.id,
			kind: change.kind,
			// Gebunden wird an die Fassung, die daraus WIRD - der Server zaehlt beim
			// Annehmen hoch. Andernfalls passte die Bindung nach dem Ablegen nicht mehr.
			rev: rev + 1
		});
		return {
			id: item.id,
			kind: change.kind,
			bucket,
			baseRev: rev,
			updatedAt: item.updatedAt ?? Date.now(),
			payload: packSealed(sealed)
		};
	}

	// ---------- Herunterladen ----------

	async #pullAll(): Promise<{ pulled: number; lostEdits: number }> {
		let pulled = 0;
		let lostEdits = 0;
		for (;;) {
			const seite = await this.#api.pull(this.#state.seq, { limit: BATCH });
			if (seite.records.length > 0) {
				const r = await this.#apply(seite.records);
				pulled += seite.records.length;
				lostEdits += r.lostEdits;
			}
			this.#state = { seq: seite.nextSeq };
			await this.#saveState(this.#state);
			if (!seite.hasMore) break;
		}
		return { pulled, lostEdits };
	}

	/**
	 * Serverdaten einspielen - ohne dass der Haken sie als eigene Aenderung nimmt.
	 *
	 * Die Klammer sitzt hier und nicht tiefer: alles darunter schreibt lokal, und
	 * kein einziger dieser Schreibvorgaenge ist eine Aenderung DIESES Geraets.
	 */
	async #apply(records: ServerRecord[]): Promise<{ lostEdits: number }> {
		return applyingRemote(() => this.#applyInner(records));
	}

	async #applyInner(records: ServerRecord[]): Promise<{ lostEdits: number }> {
		const offen = new Set(pendingChanges().map((c) => `${c.kind}:${c.id}`));
		let lostEdits = 0;

		// Nach Art trennen: Eintraege gehen monatsweise, alles andere in einem Zug.
		const eintraege = records.filter((r) => r.kind === "entry");
		const aktivitaeten = records.filter((r) => r.kind === "activity");
		const settings = records.filter((r) => r.kind === "settings");

		lostEdits += await this.#applyEntries(eintraege, offen);
		if (aktivitaeten.length > 0) lostEdits += await this.#applyActivities(aktivitaeten, offen);
		if (settings.length > 0) lostEdits += await this.#applySettings(settings[settings.length - 1], offen);
		return { lostEdits };
	}

	async #applyEntries(records: ServerRecord[], offen: Set<string>): Promise<number> {
		if (records.length === 0) return 0;
		let lost = 0;

		// Entschluesseln, um zu erfahren, in welchen Monat ein Datensatz gehoert -
		// der Server weiss das nicht, und die Kennung daneben ist verschleiert.
		const nachMonat = new Map<string, { remote: Entry; deleted: boolean }[]>();
		for (const r of records) {
			const entschluesselt = await this.#open<Entry>(r);
			if (entschluesselt === undefined) continue;
			const eintrag: Entry = {
				...entschluesselt,
				id: r.id,
				updatedAt: r.updatedAt,
				rev: r.rev,
				deviceId: r.deviceId ?? undefined
			};
			// Bei einem Grabstein gibt es keinen Inhalt - der Monat muss dann aus dem
			// lokalen Bestand kommen. Kennen wir ihn nicht, ist die Loeschung ohnehin
			// gegenstandslos.
			const monat = r.deletedAt ? await this.#findMonth(r.id) : monthKey(eintrag.startTs);
			if (!monat) continue;
			const liste = nachMonat.get(monat) ?? [];
			liste.push({ remote: eintrag, deleted: r.deletedAt !== null });
			nachMonat.set(monat, liste);
		}

		for (const [monat, eingehend] of nachMonat) {
			const lokal = await this.#store.entriesOfMonth(monat);
			const byId = new Map(lokal.map((e) => [e.id, e]));
			let veraendert = false;

			for (const { remote, deleted } of eingehend) {
				const ergebnis = mergeRecord(
					{
						local: byId.get(remote.id),
						remote: deleted ? { ...remote, deletedAt: remote.updatedAt } : remote,
						localPending: offen.has(`entry:${remote.id}`)
					},
					(v) => (v as Entry & { deletedAt?: number }).deletedAt !== undefined
				);
				if (ergebnis.lostLocalEdit) lost++;
				if (!ergebnis.changed) continue;
				veraendert = true;
				if (ergebnis.value === null) byId.delete(remote.id);
				else byId.set(remote.id, ergebnis.value);
			}

			if (!veraendert) continue;
			let liste = [...byId.values()].sort((a, b) => a.startTs - b.startTs);

			// Die eine Regel, die der Abgleich neu einfuehrt: hoechstens ein offener
			// Eintrag. Zwei Geraete halten sonst je einen, und beide zaehlen weiter.
			const zuSchliessen = resolveOpenEntries(liste);
			if (zuSchliessen.length > 0) {
				const fix = new Map(zuSchliessen.map((e) => [e.id, e]));
				liste = liste.map((e) => fix.get(e.id) ?? e);
				logInfo("Mehrere laufende Timer zusammengeführt", { geschlossen: zuSchliessen.length });
			}
			await this.#store.saveEntries(monat, liste);
		}
		return lost;
	}

	async #applyActivities(records: ServerRecord[], offen: Set<string>): Promise<number> {
		const lokal = await this.#store.activities();
		const byId = new Map(lokal.map((a) => [a.id, a]));
		let lost = 0;
		let veraendert = false;

		for (const r of records) {
			const inhalt = await this.#open<Activity>(r);
			if (inhalt === undefined) continue;
			const remote: Activity & { deletedAt?: number } = {
				...inhalt,
				id: r.id,
				updatedAt: r.updatedAt,
				rev: r.rev,
				deviceId: r.deviceId ?? undefined,
				...(r.deletedAt ? { deletedAt: r.updatedAt } : {})
			};
			const ergebnis = mergeRecord(
				{ local: byId.get(r.id), remote, localPending: offen.has(`activity:${r.id}`) },
				(v) => (v as { deletedAt?: number }).deletedAt !== undefined
			);
			if (ergebnis.lostLocalEdit) lost++;
			if (!ergebnis.changed) continue;
			veraendert = true;
			if (ergebnis.value === null) byId.delete(r.id);
			else byId.set(r.id, ergebnis.value);
		}

		if (veraendert) {
			await this.#store.saveActivities([...byId.values()].sort((a, b) => a.sortOrder - b.sortOrder));
		}
		return lost;
	}

	async #applySettings(record: ServerRecord, offen: Set<string>): Promise<number> {
		const inhalt = await this.#open<Settings & { id?: string }>(record);
		if (inhalt === undefined) return 0;
		const lokal = await this.#store.settings();
		const ergebnis = mergeRecord(
			{
				local: { ...lokal, id: SETTINGS_ID },
				remote: {
					...inhalt,
					id: SETTINGS_ID,
					updatedAt: record.updatedAt,
					rev: record.rev,
					deviceId: record.deviceId ?? undefined
				},
				localPending: offen.has(`settings:${SETTINGS_ID}`)
			},
			() => false // Einstellungen werden nie geloescht - es gibt immer welche.
		);
		if (!ergebnis.changed || !ergebnis.value) return ergebnis.lostLocalEdit ? 1 : 0;
		const { id: _id, ...rest } = ergebnis.value;
		await this.#store.saveSettings(rest as Settings);
		return ergebnis.lostLocalEdit ? 1 : 0;
	}

	/**
	 * Einen Datensatz oeffnen.
	 *
	 * `undefined` heisst "nicht zu gebrauchen" - entweder ein Grabstein ohne
	 * Inhalt oder etwas, das sich nicht entschluesseln laesst. Letzteres darf den
	 * Abgleich nicht anhalten: ein einzelner unlesbarer Datensatz ist ein
	 * Aergernis, ein steckengebliebener Abgleich ein Ausfall.
	 */
	async #open<T>(r: ServerRecord): Promise<T | undefined> {
		if (!r.payload) return r.deletedAt ? ({} as T) : undefined;
		try {
			return await openRecord<T>(this.#key, unpackSealed(r.payload), {
				id: r.id,
				kind: r.kind,
				rev: r.rev
			});
		} catch (e) {
			logError(`Datensatz ${r.kind}/${r.id} ließ sich nicht entschlüsseln`, e);
			return undefined;
		}
	}

	/** In welchem Monat liegt ein Eintrag, den wir nur ueber seine Id kennen? */
	async #findMonth(id: string): Promise<string | null> {
		for (const monat of await this.#knownMonths()) {
			const liste = await this.#store.entriesOfMonth(monat);
			if (liste.some((e) => e.id === id)) return monat;
		}
		return null;
	}

	#months: string[] | null = null;
	async #knownMonths(): Promise<string[]> {
		// Innerhalb eines Durchgangs reicht eine Liste; sie aendert sich hoechstens
		// durch uns selbst, und dann kennen wir den Monat ohnehin.
		this.#months ??= await this.#monthLister();
		return this.#months;
	}

	#monthLister: () => Promise<string[]> = async () => [];
	setMonthLister(fn: () => Promise<string[]>): void {
		this.#monthLister = fn;
		this.#months = null;
	}
}

export { ApiError };
