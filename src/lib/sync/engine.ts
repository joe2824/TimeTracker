// Wann abgeglichen wird - und in welcher Reihenfolge.
//
// Der Ablauf ist immer derselbe:
//   1. Hochladen, was offen ist (aus der Outbox)
//   2. Herunterladen, was seit dem letzten Mal dazukam
//   3. Zusammenführen und lokal anwenden
//   4. Bei Konflikten: zurück zu 1, jetzt auf dem neuen Serverstand
//
// Die Herkunftsspuren bleiben aus dem Chiffrat draussen: der Server braucht sie im
// Klartext für die Reihenfolge.
import type { Entry, Activity, Settings } from "../types";
import type { StoredTimeReport } from "../store";
import { Api, ApiError, type OutgoingRecord, type ServerRecord } from "./api";
import {
	applyingRemote,
	clearChanges,
	monthOfTimeReportId,
	pendingChanges,
	SETTINGS_ID,
	type PendingChange
} from "./outbox";
import { mergeRecord, resolveOpenEntries } from "./merge";
import { contentOf } from "./stamp";
import { bucketFor, openRecord, sealRecord, type VaultKey } from "../crypto/vault";
import { logError, logInfo, logWarn } from "../log";
import { monthKey, prevMonthKey } from "../time/time";

/** Wie oft nach einem Konflikt neu versucht wird, bevor aufgegeben wird. */
const MAX_ROUNDS = 5;
/** Datensätze je Anfrage - der Server nimmt höchstens 500. */
const BATCH = 200;
/**
 * Seiten Historie je Durchgang, solange der Backfill läuft.
 *
 * Der Deckel ist kein Geiz: ohne ihn hängt eine Zeiterfassung, die während
 * eines minutenlangen Backfills gestartet wird, hinter `#running` fest, weil
 * der nächste Durchgang erst danach pusht.
 */
const BACKLOG_PAGES = 5;

export interface LocalStore {
	entriesOfMonth(month: string): Promise<Entry[]>;
	saveEntries(month: string, entries: Entry[]): Promise<void>;
	activities(): Promise<Activity[]>;
	saveActivities(list: Activity[]): Promise<void>;
	settings(): Promise<Settings>;
	saveSettings(s: Settings): Promise<void>;
	timeReport(month: string): Promise<StoredTimeReport | null>;
	saveTimeReport(report: StoredTimeReport): Promise<void>;
	deleteTimeReport(month: string): Promise<void>;
}

/**
 * Der vorgezogene Teil des Abgleichs.
 *
 * Damit kommen aktueller Monat, Vormonat, Aktivitäten und Einstellungen sofort,
 * statt hinter Jahren alter Einträge zu warten: `seq` läuft aufsteigend, die
 * ältesten Datensätze kämen also zuerst.
 */
export interface SyncPriority {
	/** Gemeinsamer Stand über die vorgezogene Menge. */
	seq: number;
	/** Welche Monate vorgezogen werden. */
	months: string[];
	/**
	 * Die Historie liegt hier bereits auf der Platte - der Nachlauf holt sie nur
	 * noch einmal. Dann fehlt lokal nichts, und die Sicherung darf laufen.
	 */
	historyLocal?: boolean;
}

export interface SyncState {
	/** Bis zu welchem Serverstand dieses Gerät alles kennt. */
	seq: number;
	/** Nur vorhanden, solange die Historie noch fehlt. */
	priority?: SyncPriority;
}

export interface SyncOutcome {
	pushed: number;
	pulled: number;
	/** Wie oft eine eigene, noch nicht hochgeladene Änderung unterlegen ist. */
	lostEdits: number;
	/**
	 * Wie oft eine Mitternachts-Teilung durch ein echtes Ende von anderswo
	 * ueberholt wurde, waehrend die Fortsetzung ab der Teilung schon lokal stand.
	 * Die Fortsetzung wird NICHT angetastet - siehe #applyEntries.
	 */
	staleTimerSplits: number;
	seq: number;
	/** Ob noch ältere Monate fehlen. */
	backfilling: boolean;
}

export interface SyncProgress {
	phase: "idle" | "pulling" | "pushing";
	pulled: number;
	pushed: number;
	/**
	 * Läuft im Hintergrund: die Historie, während die vorgezogenen Monate schon
	 * dastehen. Dafür gibt es das Hinweisband - kein Modal, das die App zusperrt.
	 */
	background?: boolean;
}

export class SyncEngine {
	#api: Api;
	#key: VaultKey;
	#store: LocalStore;
	#deviceId: string;
	#state: SyncState;
	#saveState: (s: SyncState) => Promise<void>;
	#onProgress?: (p: SyncProgress) => void;
	/** Läuft gerade ein Durchgang? Zwei gleichzeitig würden sich ins Gehege kommen. */
	#running = false;
	/** Kam während eines Durchgangs eine Anforderung? Dann gleich noch einmal. */
	#again = false;
	/** Abgemeldet: nichts mehr einspielen, nichts mehr anfangen. Siehe `stop`. */
	#stopped = false;
	/** Datensätze, die der Server nachweislich nicht kennt. */
	#unknownToServer = new Set<string>();

	constructor(opts: {
		api: Api;
		key: VaultKey;
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

	/** Ob noch ältere Monate nachkommen. */
	get backfilling(): boolean {
		return this.#state.priority !== undefined;
	}

	/**
	 * Ob lokal wirklich Monate FEHLEN.
	 *
	 * Nicht dasselbe wie `backfilling`: ein Gerät, das nach einem Nachlauf alles
	 * noch einmal holt, hat den Bestand längst - eine Sicherung wäre da
	 * vollständig.
	 */
	get historyIncomplete(): boolean {
		const priority = this.#state.priority;
		return priority !== undefined && priority.historyLocal !== true;
	}

	/**
	 * Abrufe laufen nacheinander in den Bestand.
	 *
	 * Die Anfragen selbst dürfen sich überholen - ein vorgezogener Monat soll
	 * nicht hinter dem Backfill warten. Das Einspielen nicht: zwei Seiten, die
	 * dieselbe Monatsdatei lesen, ändern und zurückschreiben, verlören sonst
	 * die Änderung der jeweils anderen.
	 */
	#chain: Promise<unknown> = Promise.resolve();

	#serial<T>(op: () => Promise<T>): Promise<T> {
		const next = this.#chain.then(op, op);
		this.#chain = next.catch(() => {});
		return next;
	}

	/** Der gerade laufende Durchgang, damit ein zweiter Aufruf mitwarten kann. */
	#current: Promise<SyncOutcome> | null = null;

	/**
	 * Einen Durchgang anstossen.
	 *
	 * Läuft schon einer, hängt sich der Aufruf an ihn an statt ins Leere zu
	 * greifen: `#again` sorgt dafür, dass danach noch eine Runde kommt, und wer
	 * `sync()` abwartet, will wissen, dass wirklich abgeglichen wurde.
	 */
	sync(): Promise<SyncOutcome | null> {
		if (this.#stopped) return Promise.resolve(null);
		if (this.#running) {
			this.#again = true;
			return this.#current ?? Promise.resolve(null);
		}
		this.#running = true;
		this.#current = this.#rounds();
		return this.#current;
	}

	/**
	 * Endgültig anhalten - beim Abmelden.
	 *
	 * Einen laufenden Durchgang holt das nicht zurück: seine Anfragen sind
	 * unterwegs. Was danach ankommt, gehört einem Konto, das dieses Gerät nicht
	 * mehr hat, und der lokale Bestand ist inzwischen gelöscht. Ohne stop()
	 * schreibt die Runde ihn Datensatz für Datensatz wieder hin.
	 */
	stop(): void {
		this.#stopped = true;
	}

	async #rounds(): Promise<SyncOutcome> {
		try {
			let outcome = await this.#round();
			while (this.#again) {
				this.#again = false;
				const more = await this.#round();
				outcome = {
					pushed: outcome.pushed + more.pushed,
					pulled: outcome.pulled + more.pulled,
					lostEdits: outcome.lostEdits + more.lostEdits,
					staleTimerSplits: outcome.staleTimerSplits + more.staleTimerSplits,
					seq: more.seq,
					backfilling: more.backfilling
				};
			}
			return outcome;
		} finally {
			this.#running = false;
			this.#again = false;
			this.#current = null;
			this.#onProgress?.({ phase: "idle", pulled: 0, pushed: 0 });
		}
	}

	async #round(): Promise<SyncOutcome> {
		// Die Monatsliste gilt je Durchgang - siehe #knownMonths.
		this.#months = null;
		this.#allMonthsIndexed = false;
		const up = await this.#pushAll();
		const down = this.#state.priority
			? await this.#pullStaged(up.pushed)
			: await this.#pullBacklog(up.pushed, Infinity);
		return {
			pushed: up.pushed,
			pulled: up.pulled + down.pulled,
			lostEdits: up.lostEdits + down.lostEdits,
			staleTimerSplits: up.staleTimerSplits + down.staleTimerSplits,
			seq: this.#state.seq,
			backfilling: this.backfilling
		};
	}

	/**
	 * Erst das Vorgezogene, dann ein Stück Historie.
	 *
	 * Solange der Backfill läuft, geht jede Runde zuerst über die vorgezogenen
	 * Monate: neue Zeiten von anderen Geräten sollen ankommen, auch wenn die
	 * alten Jahre noch tagelang tropfen.
	 */
	async #pullStaged(
		pushed: number
	): Promise<{ pulled: number; lostEdits: number; staleTimerSplits: number }> {
		await this.#followCalendar();
		const first = await this.#pullPriority(pushed);
		// Was jemand gleich sehen will, schlägt Historie: läuft gerade ein Monat
		// auf Zuruf, setzt die Historie diese Runde aus. Nur aussetzen, nicht
		// warten - warten hiesse, dass sich beide gegenseitig aufhalten.
		const budget = this.#monthFetches.size > 0 ? 0 : BACKLOG_PAGES;
		const rest = await this.#pullBacklog(pushed + first.pulled, budget, true);
		// Die Historie ist durch: ab jetzt reicht der eine Stand wieder für alles.
		if (rest.done && this.#state.priority) {
			this.#state = { seq: this.#state.seq };
			await this.#saveState(this.#state);
			logInfo("Ältere Monate vollständig geladen");
		}
		return {
			pulled: first.pulled + rest.pulled,
			lostEdits: first.lostEdits + rest.lostEdits,
			staleTimerSplits: first.staleTimerSplits + rest.staleTimerSplits
		};
	}

	// ---------- Hochladen ----------

	async #pushAll(): Promise<{
		pushed: number;
		pulled: number;
		lostEdits: number;
		staleTimerSplits: number;
	}> {
		let total = 0;
		let pulled = 0;
		let lostEdits = 0;
		let staleTimerSplits = 0;
		for (let round = 0; round < MAX_ROUNDS; round++) {
			const open = pendingChanges();
			if (open.length === 0) break;

			const batch = open.slice(0, BATCH);
			const records = await this.#toOutgoing(batch);
			if (records.length === 0) {
				// Nichts Verwertbares dabei - etwa lauter Änderungen an Datensätzen,
				// die es lokal nicht mehr gibt. Abhaken, sonst dreht sich die Schleife
				// bis MAX_ROUNDS um nichts.
				await clearChanges(batch);
				continue;
			}

			this.#onProgress?.({ phase: "pushing", pulled, pushed: total });
			const answer = await this.#api.push(records);
			total += answer.accepted.length;
			this.#onProgress?.({ phase: "pushing", pulled, pushed: total });

			// Nur das Angenommene abhaken. Was im Konflikt steckt, bleibt offen und
			// geht in die nächste Runde - dann auf dem inzwischen bekannten Stand.
			const acked = new Set(answer.accepted.map((a) => a.id));
			await clearChanges(batch.filter((c) => acked.has(c.id)));
			// Angekommen heisst: die Fassung stimmt wieder. Bliebe die Merkliste
			// stehen, würde später fälschlich mit 0 geschrieben und ein echter
			// Konflikt ginge dabei unbemerkt verloren.
			for (const id of acked) this.#unknownToServer.delete(id);

			if (answer.conflicts.length > 0) {
				for (const k of answer.conflicts) {
					// Fassung 0 heisst: der Server hat diesen Datensatz gar nicht. Dann
					// hilft kein Zusammenführen - es gibt nichts, womit. Die nächste
					// Runde schreibt ihn als neu an.
					if (k.current.rev === 0) this.#unknownToServer.add(k.id);
					else this.#unknownToServer.delete(k.id);
				}
				// Nur die Datensätze aus der Konfliktantwort anwenden, KEIN
				// Backlog-Abruf: der holte auf einem Konto mit Jahren an Daten die
				// ganze Historie in einem Zug und riss das Budget von #pullStaged ein.
				//
				// Der Cursor bleibt dabei stehen. Nach der Invariante ist ein zu alter
				// Cursor nur redundant, nie lückenhaft, und mergeRecord ist idempotent.
				const current = answer.conflicts.map((k) => k.current);
				pulled += current.length;
				const applied = await this.#apply(current);
				lostEdits += applied.lostEdits;
				staleTimerSplits += applied.staleTimerSplits;
				continue;
			}
			if (batch.length === open.length) break;
		}
		return { pushed: total, pulled, lostEdits, staleTimerSplits };
	}

	async #toOutgoing(changes: PendingChange[]): Promise<OutgoingRecord[]> {
		const out: OutgoingRecord[] = [];
		// Die Monatsdateien einmal lesen statt je Änderung: ein Tag mit zwanzig
		// Einträgen läge sonst zwanzigmal auf dem Tisch.
		const months = new Map<string, Entry[]>();
		const monthOf = async (m: string) => {
			if (!months.has(m)) months.set(m, await this.#store.entriesOfMonth(m));
			return months.get(m)!;
		};
		let activities: Activity[] | null = null;

		for (const c of changes) {
			try {
				if (c.kind === "entry") {
					const list = await monthOf(c.month ?? "");
					const entry = list.find((e) => e.id === c.id);
					out.push(await this.#record(c, entry, entry ? monthKey(entry.startTs) : c.month));
				} else if (c.kind === "activity") {
					activities ??= await this.#store.activities();
					out.push(await this.#record(c, activities.find((a) => a.id === c.id)));
				} else if (c.kind === "timereport") {
					const month = monthOfTimeReportId(c.id);
					const report = month ? await this.#store.timeReport(month) : null;
					out.push(await this.#record(c, report ? { ...report, id: c.id } : undefined));
				} else {
					out.push(await this.#record(c, { ...(await this.#store.settings()), id: SETTINGS_ID }));
				}
			} catch (e) {
				// Ein einzelner Datensatz, der sich nicht verpacken lässt, darf den
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
		// Ob gelöscht wurde, sagt die Outbox - nicht das Fehlen des Datensatzes.
		if (change.deleted || !item) {
			return {
				id: change.id,
				kind: change.kind,
				bucket,
				// Die Fassung aus der Outbox; nur wenn auch die fehlt, fällt es auf
				// "gab es beim Server noch nie" zurück.
				baseRev: this.#unknownToServer.has(change.id) ? 0 : (change.rev ?? item?.rev ?? 0),
				updatedAt: change.at,
				deletedAt: change.at
			};
		}
		// Kennt der Server den Datensatz nicht, wird er als neu geschrieben - und
		// zwar HIER, vor dem Versiegeln. Die Bindung des Chiffrats zeigt auf die
		// Fassung, die daraus wird; nachträglich am fertigen Datensatz zu drehen
		// würde sie falsch machen und das Öffnen scheitern lassen.
		const rev = this.#unknownToServer.has(item.id) ? 0 : (item.rev ?? 0);
		const payload = await sealRecord(this.#key, contentOf(item), {
			id: item.id,
			kind: change.kind,
			// Gebunden wird an die Fassung, die daraus WIRD - der Server zählt beim
			// Annehmen hoch. Andernfalls passte die Bindung nach dem Ablegen nicht mehr.
			rev: rev + 1
		});
		return {
			id: item.id,
			kind: change.kind,
			bucket,
			baseRev: rev,
			updatedAt: item.updatedAt ?? Date.now(),
			payload
		};
	}

	// ---------- Herunterladen ----------

	/**
	 * Die Historie, seitenweise ab dem allgemeinen Stand.
	 *
	 * `maxPages` deckelt, wie viel davon in einem Durchgang kommt. `done` heisst:
	 * der Server hat nichts mehr, dieses Gerät kennt alles.
	 */
	async #pullBacklog(
		pushed: number,
		maxPages: number,
		background = false
	): Promise<{ pulled: number; lostEdits: number; staleTimerSplits: number; done: boolean }> {
		let pulled = 0;
		let lostEdits = 0;
		let staleTimerSplits = 0;
		let done = false;
		this.#onProgress?.({ phase: "pulling", pulled, pushed, background });
		for (let i = 0; i < maxPages; i++) {
			const page = await this.#api.pull(this.#state.seq, { limit: BATCH });
			if (page.records.length > 0) {
				pulled += page.records.length;
				this.#onProgress?.({ phase: "pulling", pulled, pushed, background });
				const r = await this.#apply(page.records);
				lostEdits += r.lostEdits;
				staleTimerSplits += r.staleTimerSplits;
			}
			this.#state = { ...this.#state, seq: page.nextSeq };
			await this.#saveState(this.#state);
			if (!page.hasMore) {
				done = true;
				break;
			}
		}
		return { pulled, lostEdits, staleTimerSplits, done };
	}

	/** Die vorgezogene Menge: die genannten Monate plus Aktivitäten und Einstellungen. */
	async #pullPriority(
		pushed: number
	): Promise<{ pulled: number; lostEdits: number; staleTimerSplits: number }> {
		let pulled = 0;
		let lostEdits = 0;
		let staleTimerSplits = 0;
		if (!this.#state.priority) return { pulled, lostEdits, staleTimerSplits };
		// Einmal rechnen, nicht je Seite: kommt währenddessen ein Monat dazu, holt
		// ihn die nächste Runde. Ein zu alter Stand liefert doppelt, nie zu wenig.
		const buckets = await Promise.all(
			this.#state.priority.months.map((m) => bucketFor(this.#key, m))
		);
		this.#onProgress?.({ phase: "pulling", pulled, pushed });
		for (;;) {
			const before = this.#state.priority;
			if (!before) break;
			const page = await this.#api.pull(before.seq, {
				limit: BATCH,
				buckets,
				// Ohne die hätte die Oberfläche weder Namen noch Rundung noch
				// Sollstunden - die hängen an Datensätzen ohne Zeitraum.
				unbucketed: true
			});
			if (page.records.length > 0) {
				pulled += page.records.length;
				this.#onProgress?.({ phase: "pulling", pulled, pushed });
				const r = await this.#apply(page.records);
				lostEdits += r.lostEdits;
				staleTimerSplits += r.staleTimerSplits;
			}
			// Frisch aus dem Zustand: während des Abrufs kann ein Monat dazugekommen sein.
			const current = this.#state.priority;
			if (!current) break;
			this.#state = { ...this.#state, priority: { ...current, seq: page.nextSeq } };
			await this.#saveState(this.#state);
			if (!page.hasMore) break;
		}
		return { pulled, lostEdits, staleTimerSplits };
	}

	/** Über Mitternacht hinweg: nach einem Monatswechsel gehört der neue mit vorn hin. */
	async #followCalendar(): Promise<void> {
		const now = Date.now();
		await this.ensureMonthSynced(monthKey(now));
		await this.ensureMonthSynced(prevMonthKey(now));
	}

	/** Laufende Nachladungen, damit zweimal Hovern nicht zweimal lädt. */
	#monthFetches = new Map<string, Promise<void>>();

	/** Läuft für diesen Monat gerade ein Abruf? Die Auswahl zeigt dazu einen Spinner. */
	isFetchingMonth(month: string): boolean {
		return this.#monthFetches.has(month);
	}

	/**
	 * Einen Monat holen, den der Backfill noch nicht erreicht hat.
	 *
	 * Ist die Historie durch, liegt ohnehin alles vor und der Aufruf kostet nichts.
	 */
	ensureMonthSynced(month: string): Promise<void> {
		const priority = this.#state.priority;
		if (!priority || priority.months.includes(month)) return Promise.resolve();
		let running = this.#monthFetches.get(month);
		if (!running) {
			running = this.#fetchMonth(month).finally(() => this.#monthFetches.delete(month));
			this.#monthFetches.set(month, running);
		}
		return running;
	}

	async #fetchMonth(month: string): Promise<void> {
		const bucket = await bucketFor(this.#key, month);
		let since = 0;
		for (;;) {
			const page = await this.#api.pull(since, { limit: BATCH, buckets: [bucket] });
			if (page.records.length > 0) await this.#apply(page.records);
			since = page.nextSeq;
			if (!page.hasMore) break;
		}

		// Aufnehmen, aber den gemeinsamen Stand NICHT nachziehen: er darf hinterher
		// sein - dann kommt dieser Monat später noch einmal, was nichts kostet.
		// Vorziehen würde überspringen, was die anderen Monate noch nicht kennen.
		const current = this.#state.priority;
		if (!current || current.months.includes(month)) return;
		this.#state = { ...this.#state, priority: { ...current, months: [...current.months, month] } };
		await this.#saveState(this.#state);
		logInfo(`Monat ${month} nachgeladen`);
	}

	/** Serverdaten einspielen - ohne dass der Haken sie als eigene Änderung nimmt. */
	async #apply(records: ServerRecord[]): Promise<{ lostEdits: number; staleTimerSplits: number }> {
		if (this.#stopped) return { lostEdits: 0, staleTimerSplits: 0 };
		return this.#serial(() => applyingRemote(() => this.#applyInner(records)));
	}

	async #applyInner(
		records: ServerRecord[]
	): Promise<{ lostEdits: number; staleTimerSplits: number }> {
		const open = new Set(pendingChanges().map((c) => `${c.kind}:${c.id}`));
		let lostEdits = 0;

		// Nach Art trennen: Einträge gehen monatsweise, alles andere in einem Zug.
		const entries = records.filter((r) => r.kind === "entry");
		const activities = records.filter((r) => r.kind === "activity");
		const settings = records.filter((r) => r.kind === "settings");
		const reports = records.filter((r) => r.kind === "timereport");

		const entryResult = await this.#applyEntries(entries, open);
		lostEdits += entryResult.lost;
		if (activities.length > 0) lostEdits += await this.#applyActivities(activities, open);
		if (settings.length > 0) lostEdits += await this.#applySettings(settings[settings.length - 1], open);
		for (const r of reports) lostEdits += await this.#applyTimeReport(r, open);
		return { lostEdits, staleTimerSplits: entryResult.staleTimerSplits };
	}

	async #applyEntries(
		records: ServerRecord[],
		open: Set<string>
	): Promise<{ lost: number; staleTimerSplits: number }> {
		if (records.length === 0) return { lost: 0, staleTimerSplits: 0 };
		let lost = 0;
		let staleTimerSplits = 0;

		// Die angefassten Monate, je Monat eine Karte nach Id. Einmal von der Platte,
		// danach nur noch im Speicher - denn ein Eintrag kann beim Zusammenführen
		// den Monat WECHSELN, und dann sind zwei Monatsdateien gleichzeitig in Arbeit.
		const loaded = new Map<string, Map<string, Entry>>();
		const touched = new Set<string>();
		const monthOf = async (m: string) => {
			let monthMap = loaded.get(m);
			if (!monthMap) {
				monthMap = new Map((await this.#store.entriesOfMonth(m)).map((e) => [e.id, e]));
				loaded.set(m, monthMap);
			}
			return monthMap;
		};

		const decrypted = await Promise.all(
			records.map(async (r) => {
				const content = await this.#open<Entry>(r);
				return { r, content };
			})
		);

		for (const { r, content } of decrypted) {
			if (content === undefined) continue;
			const entry: Entry = {
				...content,
				id: r.id,
				updatedAt: r.updatedAt,
				rev: r.rev,
				deviceId: r.deviceId ?? undefined
			};
			const deleted = r.deletedAt !== null;

			// Zwei verschiedene Monate, und sie auseinanderzuhalten ist der Punkt:
			// `oldMonth` ist, wo der Eintrag HEUTE lokal liegt, `targetMonth`, wo er nach
			// dieser Änderung hingehört. Wer einen Eintrag über eine Monatsgrenze
			// schiebt, hatte ihn sonst auf dem anderen Gerät zweimal - neu im Zielmonat,
			// alt im Ausgangsmonat, und dort räumte ihn nie jemand weg.
			const targetMonth = deleted ? null : monthKey(entry.startTs);
			// Der Normalfall ist "liegt schon dort, wo er hingehört" - dann kostet die
			// Frage nichts. Erst wenn er da nicht steht, wird der Bestand durchgesehen.
			const oldMonth =
				targetMonth && (await monthOf(targetMonth)).has(r.id)
					? targetMonth
					: await this.#findMonth(r.id, loaded, monthOf);

			// Kennen wir den Eintrag gar nicht, ist eine Löschung gegenstandslos.
			const writeMonth = targetMonth ?? oldMonth;
			if (!writeMonth) continue;

			// Verglichen wird mit dem lokalen Stand, wo immer er liegt. Gegen den
			// leeren Zielmonat zu vergleichen hiesse: "kennen wir nicht, nimm den
			// Serverstand" - und eine eigene, jüngere Änderung fiele lautlos weg.
			const localEntry = oldMonth ? (await monthOf(oldMonth)).get(r.id) : undefined;
			let localPending = open.has(`entry:${r.id}`);
			// Haengt an diesem Ende eine unversendete Mitternachts-Fortsetzung (kein
			// `rev`), ist das Ende selbst keine bewusste eigene Entscheidung, die einen
			// Konflikt ausfechten duerfte - sonst gewinnt die Teilung rein zufaellig
			// dadurch, dass der Rechner erst NACH der echten fremden Aenderung wieder
			// online kam (spaeterer Stempel, aber ohne jede Kenntnis vom echten Ende).
			let hasUnresolvedContinuation = false;
			if (localEntry && localEntry.endTs !== null) {
				const contMonth = await monthOf(monthKey(localEntry.endTs));
				hasUnresolvedContinuation = [...contMonth.values()].some(
					(e) =>
						e.activityId === localEntry.activityId &&
						e.startTs === localEntry.endTs &&
						e.rev === undefined
				);
			}
			if (localPending && hasUnresolvedContinuation) localPending = false;
			const result = mergeRecord(
				{
					local: localEntry,
					remote: deleted ? { ...entry, deletedAt: entry.updatedAt } : entry,
					localPending
				},
				(v) => (v as Entry & { deletedAt?: number }).deletedAt !== undefined
			);
			if (result.lostLocalEdit) lost++;
			// Die Fortsetzung selbst bleibt unangetastet - beide Seiten koennen recht
			// haben (der Nutzer hat vielleicht doch weitergearbeitet und den Timer nur
			// nicht neu gestartet). Statt zu raten, meldet #applyInner das nach oben,
			// damit ein Mensch den Tag prueft.
			if (hasUnresolvedContinuation && result.changed) staleTimerSplits++;
			if (!result.changed) continue;

			if (oldMonth && oldMonth !== writeMonth) {
				(await monthOf(oldMonth)).delete(r.id);
				touched.add(oldMonth);
			}
			const monthMap = await monthOf(writeMonth);
			if (result.value === null) monthMap.delete(r.id);
			else monthMap.set(r.id, result.value);
			touched.add(writeMonth);
		}

		if (touched.size === 0) return { lost, staleTimerSplits };
		await this.#closeSurplusOpen(loaded, touched, monthOf);

		for (const month of touched) {
			const list = [...loaded.get(month)!.values()].sort((a, b) => a.startTs - b.startTs);
			await this.#store.saveEntries(month, list);
			// Ein Monat, den wir gerade selbst angelegt haben, steht in keiner
			// Verzeichnisliste, die vor diesem Durchgang gezogen wurde.
			this.#rememberMonth(month);
		}
		return { lost, staleTimerSplits };
	}

	/**
	 * Die eine Regel, die der Abgleich neu einführt: höchstens EIN offener
	 * Eintrag - und zwar über alle Monate hinweg.
	 */
	async #closeSurplusOpen(
		loaded: Map<string, Map<string, Entry>>,
		touched: Set<string>,
		monthOf: (m: string) => Promise<Map<string, Entry>>
	): Promise<void> {
		const openAmong = [...touched].some((m) =>
			[...loaded.get(m)!.values()].some((e) => e.endTs === null)
		);
		if (!openAmong) return;

		for (const month of await this.#knownMonths()) await monthOf(month);

		const all: Entry[] = [];
		for (const monthMap of loaded.values()) all.push(...monthMap.values());
		const toClose = resolveOpenEntries(all);
		if (toClose.length === 0) return;

		for (const e of toClose) {
			for (const [month, monthMap] of loaded) {
				if (!monthMap.has(e.id)) continue;
				monthMap.set(e.id, e);
				touched.add(month);
			}
		}
		logInfo("Mehrere laufende Timer zusammengeführt", { closed: toClose.length });
	}

	async #applyActivities(records: ServerRecord[], open: Set<string>): Promise<number> {
		const local = await this.#store.activities();
		const byId = new Map(local.map((a) => [a.id, a]));
		let lost = 0;
		let changed = false;

		for (const r of records) {
			const content = await this.#open<Activity>(r);
			if (content === undefined) continue;
			const remote: Activity & { deletedAt?: number } = {
				...content,
				id: r.id,
				updatedAt: r.updatedAt,
				rev: r.rev,
				deviceId: r.deviceId ?? undefined,
				...(r.deletedAt ? { deletedAt: r.updatedAt } : {})
			};
			const result = mergeRecord(
				{ local: byId.get(r.id), remote, localPending: open.has(`activity:${r.id}`) },
				(v) => (v as { deletedAt?: number }).deletedAt !== undefined
			);
			if (result.lostLocalEdit) lost++;
			if (!result.changed) continue;
			changed = true;
			if (result.value === null) byId.delete(r.id);
			else byId.set(r.id, result.value);
		}

		if (changed) {
			await this.#store.saveActivities([...byId.values()].sort((a, b) => a.sortOrder - b.sortOrder));
		}
		return lost;
	}

	async #applySettings(record: ServerRecord, open: Set<string>): Promise<number> {
		const content = await this.#open<Settings & { id?: string }>(record);
		if (content === undefined) return 0;
		const local = await this.#store.settings();
		const result = mergeRecord(
			{
				local: { ...local, id: SETTINGS_ID },
				remote: {
					...content,
					id: SETTINGS_ID,
					updatedAt: record.updatedAt,
					rev: record.rev,
					deviceId: record.deviceId ?? undefined
				},
				localPending: open.has(`settings:${SETTINGS_ID}`)
			},
			() => false // Einstellungen werden nie gelöscht - es gibt immer welche.
		);
		if (!result.changed || !result.value) return result.lostLocalEdit ? 1 : 0;
		const { id: _id, ...rest } = result.value;
		await this.#store.saveSettings(rest as Settings);
		// Der Server hat gewonnen: der lokal offene Stand ist jetzt Makulatur, nicht
		// bloss veraltet. Ohne dieses Abhaken versucht #pushAll ihn beim naechsten
		// Durchlauf trotzdem erneut hochzuladen - und weil lokal und Server danach
		// identisch sind, bleibt "1 Aenderung ausstehend" dauerhaft stehen, obwohl es
		// nichts mehr zu senden gibt.
		if (result.lostLocalEdit) await clearChanges([{ kind: "settings", id: SETTINGS_ID }]);
		return result.lostLocalEdit ? 1 : 0;
	}

	/**
	 * Einen Report einspielen - ein Datensatz je Monat, als Ganzes.
	 *
	 * Anders als bei den Einträgen gibt es hier nichts feldweise zusammenzuführen:
	 * ein Report ist die Abschrift EINER Datei, entweder die eine oder die andere.
	 */
	async #applyTimeReport(record: ServerRecord, open: Set<string>): Promise<number> {
		const month = monthOfTimeReportId(record.id);
		// Eine Id ohne erkennbaren Monat gehört zu einer Fassung, die wir nicht
		// kennen - dann lieber nichts tun als in die falsche Datei schreiben.
		if (!month) return 0;
		const content = await this.#open<StoredTimeReport & { id?: string }>(record);
		if (content === undefined) return 0;
		const local = await this.#store.timeReport(month);
		const deleted = record.deletedAt !== null;
		const result = mergeRecord<StoredTimeReport & { id: string; deletedAt?: number }>(
			{
				local: local ? { ...local, id: record.id } : undefined,
				remote: {
					...content,
					id: record.id,
					month,
					updatedAt: record.updatedAt,
					rev: record.rev,
					deviceId: record.deviceId ?? undefined,
					...(deleted ? { deletedAt: record.updatedAt } : {})
				},
				localPending: open.has(`timereport:${record.id}`)
			},
			(v) => v.deletedAt !== undefined
		);
		if (!result.changed) return result.lostLocalEdit ? 1 : 0;
		if (result.value === null) await this.#store.deleteTimeReport(month);
		else {
			const { id: _id, deletedAt: _deletedAt, ...rest } = result.value;
			await this.#store.saveTimeReport(rest as StoredTimeReport);
		}
		return result.lostLocalEdit ? 1 : 0;
	}

	/** Einen Datensatz öffnen. */
	async #open<T>(r: ServerRecord): Promise<T | undefined> {
		if (!r.payload) return r.deletedAt ? ({} as T) : undefined;
		try {
			return await openRecord<T>(this.#key, r.payload, {
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

	/** In welchem Monat liegt ein Eintrag, den wir nur über seine Id kennen? */
	async #findMonth(
		id: string,
		loaded: Map<string, Map<string, Entry>>,
		monthOf: (m: string) => Promise<Map<string, Entry>>
	): Promise<string | null> {
		// Zuerst, was schon auf dem Tisch liegt: ein Monat, den dieser Stapel selbst
		// angelegt hat, steht in keiner Verzeichnisliste.
		for (const [month, monthMap] of loaded) if (monthMap.has(id)) return month;
		// Noch nicht alle Monate geladen? Einmalig durchsehen und im Speicher behalten.
		if (!this.#allMonthsIndexed) {
			for (const month of await this.#knownMonths()) {
				if (!loaded.has(month)) {
					const monthMap = await monthOf(month);
					if (monthMap.has(id)) return month;
				}
			}
			this.#allMonthsIndexed = true;
		}
		return null;
	}

	#months: string[] | null = null;

	/** Die Monate mit Einträgen - gepuffert je Durchgang, nicht auf Lebenszeit. */
	async #knownMonths(): Promise<string[]> {
		this.#months ??= await this.#monthLister();
		return this.#months;
	}

	/** Einen gerade selbst geschriebenen Monat in die Liste dieses Durchgangs nehmen. */
	#rememberMonth(month: string): void {
		if (this.#months && !this.#months.includes(month)) this.#months.push(month);
	}

	#monthLister: () => Promise<string[]> = async () => [];
	setMonthLister(fn: () => Promise<string[]>): void {
		this.#monthLister = fn;
		this.#months = null;
	}
}

export { ApiError };
