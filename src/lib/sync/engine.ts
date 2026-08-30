// Wann abgeglichen wird - und in welcher Reihenfolge.
//
// Der Ablauf ist immer derselbe:
//   1. Hochladen, was offen ist (aus der Outbox)
//   2. Herunterladen, was seit dem letzten Mal dazukam
//   3. Zusammenfuehren und lokal anwenden
//   4. Bei Konflikten: zurueck zu 1, jetzt auf dem neuen Serverstand
//
// Die Herkunftsspuren bleiben aus dem Chiffrat draussen: der Server braucht sie im
// Klartext fuer die Reihenfolge.
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

/** Das Chiffrat samt Zufallswert als eine Zeichenkette. */
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

/** Was von einem Eintrag verschluesselt wird. */
function contentOf<T extends { updatedAt?: number; rev?: number; deviceId?: string }>(
	item: T
): Omit<T, "updatedAt" | "rev" | "deviceId"> {
	const { updatedAt: _u, rev: _r, deviceId: _d, ...rest } = item;
	return rest;
}

export interface SyncProgress {
	phase: "idle" | "pulling" | "pushing";
	pulled: number;
	pushed: number;
}

export class SyncEngine {
	#api: Api;
	#key: CryptoKey;
	#store: LocalStore;
	#deviceId: string;
	#state: SyncState;
	#saveState: (s: SyncState) => Promise<void>;
	#onProgress?: (p: SyncProgress) => void;
	/** Laeuft gerade ein Durchgang? Zwei gleichzeitig wuerden sich ins Gehege kommen. */
	#running = false;
	/** Kam waehrend eines Durchgangs eine Anforderung? Dann gleich noch einmal. */
	#again = false;
	/** Datensaetze, die der Server nachweislich nicht kennt. */
	#unbekanntBeimServer = new Set<string>();

	constructor(opts: {
		api: Api;
		key: CryptoKey;
		store: LocalStore;
		deviceId: string;
		state: SyncState;
		saveState: (s: SyncState) => Promise<void>;
		onProgress?: (p: SyncProgress) => void;
	}) {
		this.#api = opts.api;
		this.#key = opts.key;
		this.#store = opts.store;
		this.#deviceId = opts.deviceId;
		this.#state = opts.state;
		this.#saveState = opts.saveState;
		this.#onProgress = opts.onProgress;
	}

	get seq(): number {
		return this.#state.seq;
	}

	/** Einen Durchgang anstossen. */
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
			this.#onProgress?.({ phase: "idle", pulled: 0, pushed: 0 });
		}
	}

	async #round(): Promise<SyncOutcome> {
		// Die Monatsliste gilt je Durchgang - siehe #knownMonths.
		this.#months = null;
		this.#allMonthsIndexed = false;
		const hoch = await this.#pushAll();
		const runter = await this.#pullAll(hoch.pushed);
		return {
			pushed: hoch.pushed,
			pulled: hoch.pulled + runter.pulled,
			lostEdits: hoch.lostEdits + runter.lostEdits,
			seq: this.#state.seq
		};
	}

	// ---------- Hochladen ----------

	async #pushAll(): Promise<{ pushed: number; pulled: number; lostEdits: number }> {
		let gesamt = 0;
		let pulled = 0;
		let lostEdits = 0;
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

			this.#onProgress?.({ phase: "pushing", pulled, pushed: gesamt });
			const antwort = await this.#api.push(records);
			gesamt += antwort.accepted.length;
			this.#onProgress?.({ phase: "pushing", pulled, pushed: gesamt });

			// Nur das Angenommene abhaken. Was im Konflikt steckt, bleibt offen und
			// geht in die naechste Runde - dann auf dem inzwischen bekannten Stand.
			const angenommen = new Set(antwort.accepted.map((a) => a.id));
			await clearChanges(stapel.filter((c) => angenommen.has(c.id)));
			// Angekommen heisst: die Fassung stimmt wieder. Bliebe die Merkliste
			// stehen, wuerde spaeter faelschlich mit 0 geschrieben und ein echter
			// Konflikt ginge dabei unbemerkt verloren.
			for (const id of angenommen) this.#unbekanntBeimServer.delete(id);

			if (antwort.conflicts.length > 0) {
				for (const k of antwort.conflicts) {
					// Fassung 0 heisst: der Server hat diesen Datensatz gar nicht. Dann
					// hilft kein Zusammenfuehren - es gibt nichts, womit. Die naechste
					// Runde schreibt ihn als neu an.
					if (k.current.rev === 0) this.#unbekanntBeimServer.add(k.id);
					else this.#unbekanntBeimServer.delete(k.id);
				}
				// Die Konflikte aufloesen heisst: den Serverstand holen und
				// zusammenfuehren. Danach steht die Aenderung auf der richtigen
				// Fassung und kommt in der naechsten Runde durch.
				const aufgeloest = await this.#pullAll(gesamt);
				pulled += aufgeloest.pulled;
				lostEdits += aufgeloest.lostEdits;
				continue;
			}
			if (stapel.length === offen.length) break;
		}
		return { pushed: gesamt, pulled, lostEdits };
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
		if (change.deleted || !item) {
			return {
				id: change.id,
				kind: change.kind,
				bucket,
				// Die Fassung aus der Outbox; nur wenn auch die fehlt, faellt es auf
				// "gab es beim Server noch nie" zurueck.
				baseRev: this.#unbekanntBeimServer.has(change.id) ? 0 : (change.rev ?? item?.rev ?? 0),
				updatedAt: change.at,
				deletedAt: change.at
			};
		}
		// Kennt der Server den Datensatz nicht, wird er als neu geschrieben - und
		// zwar HIER, vor dem Versiegeln. Die Bindung des Chiffrats zeigt auf die
		// Fassung, die daraus wird; nachtraeglich am fertigen Datensatz zu drehen
		// wuerde sie falsch machen und das Oeffnen scheitern lassen.
		const rev = this.#unbekanntBeimServer.has(item.id) ? 0 : (item.rev ?? 0);
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

	async #pullAll(pushed = 0): Promise<{ pulled: number; lostEdits: number }> {
		let pulled = 0;
		let lostEdits = 0;
		this.#onProgress?.({ phase: "pulling", pulled, pushed });
		for (;;) {
			const seite = await this.#api.pull(this.#state.seq, { limit: BATCH });
			if (seite.records.length > 0) {
				pulled += seite.records.length;
				this.#onProgress?.({ phase: "pulling", pulled, pushed });
				const r = await this.#apply(seite.records);
				lostEdits += r.lostEdits;
			}
			this.#state = { seq: seite.nextSeq };
			await this.#saveState(this.#state);
			if (!seite.hasMore) break;
		}
		return { pulled, lostEdits };
	}

	/** Serverdaten einspielen - ohne dass der Haken sie als eigene Aenderung nimmt. */
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

		// Die angefassten Monate, je Monat eine Karte nach Id. Einmal von der Platte,
		// danach nur noch im Speicher - denn ein Eintrag kann beim Zusammenfuehren
		// den Monat WECHSELN, und dann sind zwei Monatsdateien gleichzeitig in Arbeit.
		const geladen = new Map<string, Map<string, Entry>>();
		const beruehrt = new Set<string>();
		const monatVon = async (m: string) => {
			let karte = geladen.get(m);
			if (!karte) {
				karte = new Map((await this.#store.entriesOfMonth(m)).map((e) => [e.id, e]));
				geladen.set(m, karte);
			}
			return karte;
		};

		const entschluesselt = await Promise.all(
			records.map(async (r) => {
				const inhalt = await this.#open<Entry>(r);
				return { r, inhalt };
			})
		);

		for (const { r, inhalt } of entschluesselt) {
			if (inhalt === undefined) continue;
			const eintrag: Entry = {
				...inhalt,
				id: r.id,
				updatedAt: r.updatedAt,
				rev: r.rev,
				deviceId: r.deviceId ?? undefined
			};
			const geloescht = r.deletedAt !== null;

			// Zwei verschiedene Monate, und sie auseinanderzuhalten ist der Punkt:
			// `alt` ist, wo der Eintrag HEUTE lokal liegt, `ziel`, wo er nach dieser
			// Aenderung hingehoert. Wer einen Eintrag ueber eine Monatsgrenze schiebt,
			// hatte ihn sonst auf dem anderen Geraet zweimal - neu im Zielmonat, alt
			// im Ausgangsmonat, und dort raeumte ihn nie jemand weg.
			const ziel = geloescht ? null : monthKey(eintrag.startTs);
			// Der Normalfall ist "liegt schon dort, wo er hingehoert" - dann kostet die
			// Frage nichts. Erst wenn er da nicht steht, wird der Bestand durchgesehen.
			const alt =
				ziel && (await monatVon(ziel)).has(r.id)
					? ziel
					: await this.#findMonth(r.id, geladen, monatVon);

			// Kennen wir den Eintrag gar nicht, ist eine Loeschung gegenstandslos.
			const wohin = ziel ?? alt;
			if (!wohin) continue;

			const ergebnis = mergeRecord(
				{
					// Verglichen wird mit dem lokalen Stand, wo immer er liegt. Gegen den
					// leeren Zielmonat zu vergleichen hiesse: "kennen wir nicht, nimm den
					// Serverstand" - und eine eigene, juengere Aenderung fiele lautlos weg.
					local: alt ? (await monatVon(alt)).get(r.id) : undefined,
					remote: geloescht ? { ...eintrag, deletedAt: eintrag.updatedAt } : eintrag,
					localPending: offen.has(`entry:${r.id}`)
				},
				(v) => (v as Entry & { deletedAt?: number }).deletedAt !== undefined
			);
			if (ergebnis.lostLocalEdit) lost++;
			if (!ergebnis.changed) continue;

			if (alt && alt !== wohin) {
				(await monatVon(alt)).delete(r.id);
				beruehrt.add(alt);
			}
			const karte = await monatVon(wohin);
			if (ergebnis.value === null) karte.delete(r.id);
			else karte.set(r.id, ergebnis.value);
			beruehrt.add(wohin);
		}

		if (beruehrt.size === 0) return lost;
		await this.#closeSurplusOpen(geladen, beruehrt, monatVon);

		for (const monat of beruehrt) {
			const liste = [...geladen.get(monat)!.values()].sort((a, b) => a.startTs - b.startTs);
			await this.#store.saveEntries(monat, liste);
			// Ein Monat, den wir gerade selbst angelegt haben, steht in keiner
			// Verzeichnisliste, die vor diesem Durchgang gezogen wurde.
			this.#merkeMonat(monat);
		}
		return lost;
	}

	/**
	 * Die eine Regel, die der Abgleich neu einfuehrt: hoechstens EIN offener
	 * Eintrag - und zwar ueber alle Monate hinweg.
	 */
	async #closeSurplusOpen(
		geladen: Map<string, Map<string, Entry>>,
		beruehrt: Set<string>,
		monatVon: (m: string) => Promise<Map<string, Entry>>
	): Promise<void> {
		const offenDabei = [...beruehrt].some((m) =>
			[...geladen.get(m)!.values()].some((e) => e.endTs === null)
		);
		if (!offenDabei) return;

		for (const monat of await this.#knownMonths()) await monatVon(monat);

		const alle: Entry[] = [];
		for (const karte of geladen.values()) alle.push(...karte.values());
		const zuSchliessen = resolveOpenEntries(alle);
		if (zuSchliessen.length === 0) return;

		for (const e of zuSchliessen) {
			for (const [monat, karte] of geladen) {
				if (!karte.has(e.id)) continue;
				karte.set(e.id, e);
				beruehrt.add(monat);
			}
		}
		logInfo("Mehrere laufende Timer zusammengeführt", { geschlossen: zuSchliessen.length });
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

	/** Einen Datensatz oeffnen. */
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

	#allMonthsIndexed = false;

	/** In welchem Monat liegt ein Eintrag, den wir nur ueber seine Id kennen? */
	async #findMonth(
		id: string,
		geladen: Map<string, Map<string, Entry>>,
		monatVon: (m: string) => Promise<Map<string, Entry>>
	): Promise<string | null> {
		// Zuerst, was schon auf dem Tisch liegt: ein Monat, den dieser Stapel selbst
		// angelegt hat, steht in keiner Verzeichnisliste.
		for (const [monat, karte] of geladen) if (karte.has(id)) return monat;
		// Noch nicht alle Monate geladen? Einmalig durchsehen und im Speicher behalten.
		if (!this.#allMonthsIndexed) {
			for (const monat of await this.#knownMonths()) {
				if (!geladen.has(monat)) {
					const karte = await monatVon(monat);
					if (karte.has(id)) return monat;
				}
			}
			this.#allMonthsIndexed = true;
		}
		return null;
	}

	#months: string[] | null = null;

	/** Die Monate mit Eintraegen - gepuffert je Durchgang, nicht auf Lebenszeit. */
	async #knownMonths(): Promise<string[]> {
		this.#months ??= await this.#monthLister();
		return this.#months;
	}

	/** Einen gerade selbst geschriebenen Monat in die Liste dieses Durchgangs nehmen. */
	#merkeMonat(monat: string): void {
		if (this.#months && !this.#months.includes(monat)) this.#months.push(monat);
	}

	#monthLister: () => Promise<string[]> = async () => [];
	setMonthLister(fn: () => Promise<string[]>): void {
		this.#monthLister = fn;
		this.#months = null;
	}
}

export { ApiError };
