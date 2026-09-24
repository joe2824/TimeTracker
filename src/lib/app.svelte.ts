// Zentraler, reaktiver App-Zustand (Svelte 5 Runes).
import { toast } from "svelte-sonner";
import type { Activity, Entry, EntrySource, Settings } from "./types";
import type { StaleTimerSplitInfo } from "./sync/engine";
import {
	BUILTIN_ABSENCE,
	BUILTIN_ABSENCE_ID,
	BUILTIN_OTHERS,
	BUILTIN_OTHERS_ID,
	byActivityOrder,
	isBuiltinActivity,
	defaultSettings,
	reorderBySortOrder,
	TEAM_ACTIVITY_PREFIX
} from "./types";
import {
	fmtClock,
	fmtDate,
	fmtDateHuman,
	monthKey,
	noonTs,
	prevMonthKey,
	splitAtMidnight,
	startOfNextDay,
	stepDate
} from "./time/time";
import { setAppTimeZone, systemTimeZone, weekdayOfDate } from "./time/tz";
import { dayConflict, overlapConflict } from "./time/conflicts";
import { planBackdate, planNeedsConfirm, type BackdatePlan } from "./time/backdate";
import { errorText, logDebug, logError, logInfo, logWarn } from "./log";
import { notifyDataChanged } from "./platform/windows";
import { isTauri } from "./platform/env";
import {
	deleteYear,
	listEntryMonths,
	listTimeReportMonths,
	loadDevice,
	loadActivities,
	loadEntries,
	loadSettings,
	loadTimeReport,
	getLocalEncryptionKey,
	preloadLocalEncryptionKey,
	pruneEmptyMonthFiles,
	removeOrphanedTempFiles,
	saveActivities,
	saveEntries,
	saveSettings,
	saveTimeReport,
	settingsFileExists,
	updateDevice
} from "./store";
import { usingBrowserStorage } from "./platform/fs";

function uid(): string {
	return crypto.randomUUID();
}

/** Wie lange ein vorgeführter Hänger stehen bleibt, bevor es weitergeht. */
const DEV_HANG_MS = 20_000;

/** Ein Folgetag aus einer Mitternachts-Teilung, der auf eine Ganztags-Abwesenheit trifft. */
interface BlockedDay {
	/** Der Abwesenheits-Eintrag, der dem Tag im Weg steht. */
	entry: Entry;
	/** "YYYY-MM-DD" des betroffenen Tages. */
	date: string;
	activityName: string;
}

class AppState {
	activities = $state<Activity[]>([]);
	/** Serialisiert mergeDuplicateBuiltins() - siehe dort. */
	#builtinRepair: Promise<void> = Promise.resolve();
	settings = $state<Settings>({ ...defaultSettings });
	/** laufender Eintrag (endTs === null) oder null */
	running = $state<Entry | null>(null);
	/** tickt jede Sekunde für Live-Dauer */
	now = $state(Date.now());
	loaded = $state(false);
	/** Woran der Start gerade arbeitet – der Ladebildschirm zeigt es an. */
	initStep = $state<string | null>(null);
	/** Start gescheitert: Schritt und Meldung für den Ladebildschirm. */
	initError = $state<{ step: string; message: string } | null>(null);
	/** true = Willkommensbildschirm anzeigen (erster Start oder Dev-Re-Trigger) */
	showOnboarding = $state(false);
	/** Versteckter Dev-Modus (über das Logo aktiviert). */
	devMode = $state(false);
	/**
	 * Dev: den nächsten Startschritt scheitern lassen ("error") oder aufhalten
	 * ("hang"), sobald sein Name `step` enthält. Siehe devSimulateStartFault().
	 */
	devFail = $state<{ step: string; mode: "error" | "hang" } | null>(null);
	/** Cache: Monat "YYYY-MM" -> Einträge */
	entriesByMonth = $state<Record<string, Entry[]>>({});
	/** Zählt bei jeder Änderung an den Eintragsdateien hoch. */
	entriesVersion = $state(0);
	/**
	 * Offene Rückfrage: ein rückdatierter Start würde abgeschlossene Zeiten
	 * kürzen oder entfernen. Ein Dialog zeigt den Plan und bestätigt ihn.
	 */
	backdatePrompt = $state<{ activityId: string; start: number; plan: BackdatePlan } | null>(null);
	/**
	 * Offene Rückfrage: ein Eintrag reicht über Mitternacht in einen Tag mit
	 * Ganztags-Abwesenheit. Bestätigen entfernt die Abwesenheit(en) und legt
	 * den Eintrag danach normal an.
	 */
	absenceOverridePrompt = $state<
		| {
				kind: "add";
				args: {
					activityId: string;
					startTs: number;
					endTs: number | null;
					note: string;
					source: EntrySource;
					dayFraction?: number;
					timeOff?: boolean;
				};
				days: BlockedDay[];
		  }
		| { kind: "update"; originalStartTs: number; entry: Entry; days: BlockedDay[] }
		| null
	>(null);

	#tick: ReturnType<typeof setInterval> | null = null;

	/**
	 * Wird nur erhöht, wenn Tray-Icon und Menü sicher mit dem neuen Zustand
	 * aktualisiert werden sollen – also NACH einem vollständig abgeschlossenen
	 * Ladevorgang, nicht zwischendrin (z. B. wenn running kurz null ist).
	 * Die $effects in den Seiten lauschen NUR hierauf, nicht direkt auf running.
	 */
	trayVersion = $state(0);

	/**
	 * Daten laden und die Uhr starten. Erneut aufrufbar (Knopf "Erneut versuchen").
	 *
	 * @returns true = bereit; false = gescheitert, Details stehen in `initError`.
	 */
	async init(): Promise<boolean> {
		if (!this.loaded) {
			this.initError = null;
			const started = Date.now();
			try {
				// Vor jedem Lesen: der Schlüssel für die verschlüsselte Browser-Ablage
				// muss stehen, bevor gleich Aktivitäten/Einstellungen/Einträge kommen -
				// unabhängig vom Konto-Abgleich, der erst nach diesem init() anläuft.
				await this.#step("Verschlüsselung vorbereiten", preloadLocalEncryptionKey);
				// Erster Start? (settings.json noch nicht vorhanden – vor dem ersten Speichern prüfen)
				const firstRun = !(await this.#step("Einstellungen suchen", settingsFileExists));
				this.activities = await this.#step("Aktivitäten laden", loadActivities);
				this.settings = await this.#step("Einstellungen laden", loadSettings);
				// VOR jeder Datumsrechnung: currentMonth, prevMonthKey und
				// #findRunning hängen alle an der Zeitzone. Stünde sie erst danach,
				// lädt der Start an einer Tagesgrenze den falschen Monat.
				await this.#step("Zeitzone bestimmen", () => this.#applyTimeZone());
				// Altlasten früherer Versionen einmalig wegräumen; darf den Start nie kippen.
				await this.#step("Datenordner aufräumen", async () => {
					try {
						await pruneEmptyMonthFiles();
					} catch (e) {
						logWarn("Aufräumen leerer Monatsdateien fehlgeschlagen", e);
					}
					try {
						const n = await removeOrphanedTempFiles();
						if (n > 0) logInfo(`${n} liegengebliebene Zwischendatei(en) entfernt`);
					} catch (e) {
						logWarn("Aufräumen von Zwischendateien fehlgeschlagen", e);
					}
				});
				await this.#step("Aktivitäten prüfen", async () => {
					await this.#seedBuiltins();
					// Ohne Konto gibt es keinen Schreib-Haken und niemanden, den die
					// Reparatur erreichen müsste - dann darf sie gleich hier laufen.
					// Mit Konto übernimmt das der Abgleich, sobald er steht.
					if (!(await loadDevice())?.accountFingerprint) {
						await this.mergeDuplicateBuiltins();
					}
				});
				const month = this.currentMonth;
				await this.#step(`Einträge ${month} laden`, () => this.ensureMonth(month));
				const prev = prevMonthKey();
				await this.#step(`Einträge ${prev} laden`, () => this.ensureMonth(prev));
				const needsHistoricalEncryption = await this.#step("Verschlüsselung nachholen", () =>
					this.#encryptCurrentLocalFiles(month, prev)
				);
				await this.#step("Laufenden Timer suchen", () => this.#findRunning());
				this.showOnboarding = firstRun;
				this.loaded = true;
				this.initStep = null;
				this.trayVersion = (this.trayVersion + 1) % 1000;
				logInfo("Daten geladen", {
					ms: Date.now() - started,
					firstStart: firstRun,
					activities: this.activities.length,
					entries: this.monthEntries(month).length + this.monthEntries(prev).length,
					running: this.#runningName()
				});
				// Erst NACH "geladen": ältere Monate/Reports sind für die
				// Bedienbarkeit belanglos, sollen den Start also nicht aufhalten.
				if (needsHistoricalEncryption) {
					void this.#encryptHistoricalLocalFiles(month, prev).catch((e) =>
						logWarn("Nachhol-Verschlüsselung bestehender Dateien fehlgeschlagen", e)
					);
				}
			} catch (e) {
				// Merken statt werfen: eine abgewiesene Promise landet nur in der
				// Konsole, und davor sitzt niemand – sonst bliebe der Ladebildschirm bei "Lädt…" hängen.
				logError(`Start fehlgeschlagen beim Schritt „${this.initStep}“`, e);
				this.initError = { step: this.initStep ?? "Start", message: errorText(e) };
				return false;
			}
		}
		// IMMER (neu) starten, auch wenn die Daten schon geladen sind: der Cleanup der
		// Seite ruft dispose(). Ein früher Ausstieg oben liesse die Uhr danach stehen –
		// kein Tick, keine Live-Dauer, kein Mitternachts-Wechsel.
		this.#startTick();
		return true;
	}

	/** Einen Startschritt benennen und ausführen; der Name steht im Ladebildschirm. */
	async #step<T>(label: string, fn: () => Promise<T>): Promise<T> {
		this.initStep = label;
		await this.#devInterrupt(label);
		return await fn();
	}

	/**
	 * Dev-Störung, siehe `devFail`. Wirkt genau einmal und VOR dem Schritt: der
	 * Schritt selbst läuft dann gar nicht erst an, es wird also nichts gelesen,
	 * geschrieben oder gelöscht.
	 */
	async #devInterrupt(label: string): Promise<void> {
		const fault = this.devFail;
		if (!fault || !label.includes(fault.step)) return;
		// Zurücksetzen, bevor es knallt: der nächste Anlauf ("Erneut versuchen")
		// soll normal durchlaufen, sonst hänge man in der Schleife fest.
		this.devFail = null;
		if (fault.mode === "error") {
			throw new Error(`Test aus dem Dev-Menü: Schritt „${label}“ abgebrochen`);
		}
		logWarn(`Dev-Test: Start bleibt absichtlich bei „${label}“ stehen (${DEV_HANG_MS / 1000} s)`);
		// Von selbst weiter, statt für immer zu stehen – wer nur schauen wollte,
		// muss die App sonst neu laden.
		await new Promise((resolve) => setTimeout(resolve, DEV_HANG_MS));
	}

	/**
	 * Einmaliger Nachhol-Durchlauf, Teil 1: Aktivitäten, Einstellungen und die
	 * beiden gerade geladenen Monate verschlüsseln - kostet hier nichts extra,
	 * sie liegen schon im Speicher. Bleibt Teil des blockierenden Starts, weil
	 * er sofort fertig ist.
	 *
	 * Gibt zurück, ob noch etwas fehlt (Teil 2, ältere Monate/Reports) - ohne
	 * gesetzten Schlüssel oder mit bereits abgeschlossener Migration ist hier
	 * nichts zu tun.
	 */
	async #encryptCurrentLocalFiles(month: string, prev: string): Promise<boolean> {
		if (!usingBrowserStorage() || !getLocalEncryptionKey()) return false;
		const info = await loadDevice();
		if (!info || info.localFilesEncrypted) return false;
		try {
			await saveActivities(this.activities);
			await saveSettings(this.settings);
			if (this.entriesByMonth[month]) await saveEntries(month, this.entriesByMonth[month]);
			if (this.entriesByMonth[prev]) await saveEntries(prev, this.entriesByMonth[prev]);
			return true;
		} catch (e) {
			logWarn("Verschlüsselung des aktuellen Bestands fehlgeschlagen", e);
			return false;
		}
	}

	/**
	 * Einmaliger Nachhol-Durchlauf, Teil 2: der Rest (ältere Monate, eingelesene
	 * Reports). Absichtlich NICHT Teil des blockierenden Starts (siehe Aufrufer,
	 * läuft erst nach `loaded = true`) - für die Bedienbarkeit zählen nur
	 * Aktivitäten/Einstellungen/die beiden geladenen Monate, die Teil 1 schon
	 * erledigt hat. Gebündelt statt nacheinander: jede Datei ist unabhängig,
	 * `queued()` in store.ts serialisiert ohnehin nur je Datei, nicht global.
	 *
	 * Der Merker (`localFilesEncrypted`) wird erst hier, nach Teil 2, gesetzt -
	 * erst dann ist wirklich alles verschlüsselt.
	 */
	async #encryptHistoricalLocalFiles(month: string, prev: string): Promise<void> {
		const months = (await listEntryMonths()).filter((m) => m !== month && m !== prev);
		await Promise.all(months.map(async (m) => saveEntries(m, await loadEntries(m))));
		const reportMonths = await listTimeReportMonths();
		await Promise.all(
			reportMonths.map(async (m) => {
				const report = await loadTimeReport(m);
				if (report) await saveTimeReport(report);
			})
		);
		// Lesen und Schreiben in einem Zug: zwischen den awaits oben schreibt der
		// Abgleich seinen Stand in dieselbe Datei.
		await updateDevice((info) => info && { ...info, localFilesEncrypted: true });
	}

	#startTick(): void {
		// Erst den alten stoppen: sonst tickten nach einem Remount zwei gegeneinander,
		// mit zwei Mitternachts-Wechseln und doppelten Einträgen als Folge.
		this.dispose();
		this.#tick = setInterval(() => {
			this.now = Date.now();
			void this.#rolloverAtMidnight();
		}, 1000);
	}

	/** Tick stoppen. Für den Cleanup der Seite. */
	dispose(): void {
		if (this.#tick !== null) {
			clearInterval(this.#tick);
			this.#tick = null;
		}
	}

	/**
	 * Alle lokalen Daten im Speicher abräumen (z. B. nach Abmeldung im Browser).
	 */
	clearLocalData(): void {
		this.activities = [];
		this.settings = { ...defaultSettings };
		this.running = null;
		this.entriesByMonth = {};
		this.entriesVersion++;
		this.backdatePrompt = null;
		this.absenceOverridePrompt = null;
	}

	/**
	 * Liest Aktivitäten/Einstellungen/aktuelle Monate neu von Platte.
	 * Für das zweite Fenster (Tray-Flyout) und fensterübergreifende Updates,
	 * da jede Webview ihren eigenen Zustand hat.
	 */
	async reload(extraMonths: string[] = []): Promise<void> {
		this.activities = await loadActivities();
		this.settings = await loadSettings();
		await this.#applyTimeZone();
		// Nur die beiden aktuellen Monate und was ohnehin schon im Speicher steht.
		// Jeden Monat auf der Platte zu lesen kostete bei jedem Fensterwechsel den
		// gesamten Bestand - bei Jahren Erfassung ist das der spürbare Teil. Wer
		// Monate anlegt, die noch niemand geöffnet hat, nennt sie in `extraMonths`.
		const months = new Set([
			this.currentMonth,
			prevMonthKey(),
			...Object.keys(this.entriesByMonth),
			...extraMonths
		]);
		await Promise.all(
			[...months].map(async (m) => {
				this.entriesByMonth[m] = await loadEntries(m);
			})
		);
		this.running = null;
		await this.#findRunning();
		// Auch hier, nicht nur beim Start: ein Abgleich kann während einer offenen
		// Sitzung eine zweite "Others"-Zeile hereinspielen, und dann steht sie da,
		// bis jemand die Anwendung neu startet. Hier steht der Schreib-Haken, die
		// Reparatur wird also mitgeschrieben und erreicht die anderen Geräte.
		await this.#seedBuiltins();
		await this.mergeDuplicateBuiltins();
		this.now = Date.now();
		this.loaded = true;
		// Ein anderes Fenster hat geschrieben – abgeleitete Listen neu lesen.
		this.entriesVersion++;
		// Tray-Icon und -Menü erst jetzt aktualisieren, wenn running endgültig
		// gesetzt ist. Ein Erhöhen mitten in reload (wenn running kurz null war)
		// würde das Icon kurz auf „idle“ wechseln – das sichtbare Flackern.
		this.trayVersion = (this.trayVersion + 1) % 1000;
		logDebug("Daten neu geladen", { running: this.#runningName() });
	}

	/** Aktualisiert das native OS Tray Icon und Menü sofort imperativ. */
	async updateTrayState(): Promise<void> {
		if (!isTauri()) return;
		try {
			const { invoke } = await import("@tauri-apps/api/core");
			const quick = this.quickActivities(6).map((a) => ({
				id: a.id,
				name: a.name,
				favorite: !!a.favorite
			}));
			const running = this.running ? this.activityName(this.running.activityId) : null;
			await invoke("set_tray_state", { state: { running, activities: quick } });
		} catch {
			// kein nativer Kanal
		}
	}

	/** Name des laufenden Timers, fürs Protokoll. */
	#runningName(): string | null {
		return this.running ? this.activityName(this.running.activityId) : null;
	}

	get currentMonth(): string {
		return monthKey(this.now);
	}

	// ---------- Aktivitäten ----------
	get visibleActivities(): Activity[] {
		return this.activities.filter((a) => !a.archived).sort(byActivityOrder);
	}

	get absenceActivity(): Activity | undefined {
		return this.activities.find((a) => a.isAbsence);
	}

	activityName(id: string): string {
		const found = this.activities.find((a) => a.id === id)?.name;
		if (found) return found;
		// Ein team:-Eintrag ohne lokale Zeile ist nicht gelöscht, sondern auf
		// einem anderen Gerät desselben Kontos entstanden, das (anders als dieses)
		// Mitglied des betreffenden Teams ist - die Definition kommt bewusst nicht
		// über den Ende-zu-Ende-Sync, siehe team/activities.ts.
		return id.startsWith(TEAM_ACTIVITY_PREFIX) ? "(Team-Aktivität auf anderem Gerät)" : "(gelöscht)";
	}

	/**
	 * Die eingebauten Zeilen herstellen: genau eine je Art, unter fester Id.
	 *
	 * Läuft bei jedem Start, VOR dem ersten Abgleich - und räumt dabei auch auf.
	 * Ältere Fassungen vergaben hier Zufalls-Ids; weil jedes Gerät anlegt, bevor
	 * es die Liste vom Server kennt, entstanden so Duplikate. Die werden hier
	 * zusammengeführt: erst hängen die Einträge um, dann verschwinden die
	 * überzähligen Zeilen. Weil die Ziel-Id fest ist, wählen alle Geräte
	 * unabhängig voneinander dasselbe Ziel und laufen zusammen.
	 */
	/** Die eingebauten Zeilen, je Art eine feste Id. */
	get #builtinKinds() {
		return [
			{ id: BUILTIN_OTHERS_ID, name: BUILTIN_OTHERS, isAbsence: false },
			{ id: BUILTIN_ABSENCE_ID, name: BUILTIN_ABSENCE, isAbsence: true }
		];
	}

	#builtinsOfKind(kind: { name: string; isAbsence: boolean }): Activity[] {
		return this.activities.filter((a) =>
			kind.isAbsence ? a.isAbsence : !a.isAbsence && a.name === kind.name
		);
	}

	/**
	 * Fehlende eingebaute Zeilen anlegen - mehr nicht.
	 *
	 * Bewusst harmlos: das läuft beim Start, also bevor der Abgleich seinen
	 * Schreib-Haken gesetzt hat. Eine neu angelegte Zeile trägt noch kein `rev`
	 * und wird von rememberUnstamped() eingesammelt; alles Weitere - Einträge
	 * umhängen, Zeilen löschen - würde hier dagegen spurlos passieren.
	 */
	async #seedBuiltins(): Promise<void> {
		let changed = false;
		for (const kind of this.#builtinKinds) {
			if (this.#builtinsOfKind(kind).length > 0) continue;
			this.activities.push({
				id: kind.id,
				name: kind.name,
				sortOrder: this.activities.length,
				archived: false,
				isAbsence: kind.isAbsence
			});
			changed = true;
		}
		if (changed) {
			this.#reindexBuiltinsLast();
			await this.persistActivities();
		}
	}

	/**
	 * Doppelte eingebaute Zeilen zusammenführen.
	 *
	 * Ältere Fassungen vergaben hier Zufalls-Ids; weil jedes Gerät anlegt, bevor
	 * es die Liste vom Server kennt, entstanden Duplikate. Erst hängen die
	 * Einträge auf die feste Id um, dann verschwinden die überzähligen Zeilen.
	 * Weil die Ziel-Id fest ist, wählt jedes Gerät dasselbe Ziel.
	 *
	 * Läuft NUR dort, wo der Schreib-Haken steht (nach dem Start des Abgleichs)
	 * oder wo es keinen Abgleich gibt. Die umgehängten Einträge tragen bereits
	 * ein `rev`, rememberUnstamped() würde sie nicht mehr aufsammeln - ohne Haken
	 * bliebe die Reparatur also auf diesem Gerät stehen und erreichte den Server
	 * nie.
	 */
	async mergeDuplicateBuiltins(): Promise<void> {
		// Nacheinander, nie nebeneinander: reload() wird an mehreren Stellen ohne
		// await angestossen (Fenster-Signal, Abgleich, Tray). Zwei Durchläufe
		// läsen dieselbe Liste, und der zweite hängt seine Zeile an die des
		// ersten an - ausgerechnet dasselbe Duplikat, das hier verschwinden soll.
		this.#builtinRepair = this.#builtinRepair
			.catch(() => {})
			.then(() => this.#mergeDuplicateBuiltinsNow());
		return this.#builtinRepair;
	}

	async #mergeDuplicateBuiltinsNow(): Promise<void> {
		let changed = false;

		for (const kind of this.#builtinKinds) {
			const matches = this.#builtinsOfKind(kind);
			if (matches.length === 0) continue;

			// Nichts zu tun: genau eine, und sie sitzt schon auf der festen Id.
			if (matches.length === 1 && matches[0].id === kind.id) continue;

			// Wer überlebt: die auf der festen Id, sonst die kleinste - eine Regel,
			// die auf jedem Gerät dieselbe Zeile wählt.
			const survivor =
				matches.find((a) => a.id === kind.id) ??
				[...matches].sort((a, b) => a.id.localeCompare(b.id))[0];

			const oldIds = new Set(matches.map((a) => a.id).filter((id) => id !== kind.id));
			const moved = await this.#repointEntries(oldIds, kind.id);

			// Ohne Stempel: unter der festen Id entsteht ein NEUER Datensatz. Trägt
			// er das `rev` der alten Zeile, meldet das Gerät dem Server eine
			// Änderung an einer Fassung, die es dort nie gab - der erste Abgleich
			// nach dem Update liefe garantiert in einen Konflikt.
			const { rev: _rev, updatedAt: _updatedAt, deviceId: _deviceId, ...carried } = survivor;
			const rest = this.activities.filter((a) => !matches.includes(a));
			this.activities = [
				...rest,
				{ ...carried, id: kind.id, name: kind.name, isAbsence: kind.isAbsence }
			];
			changed = true;
			logWarn(`Eingebaute Zeile "${kind.name}" zusammengeführt`, {
				removed: oldIds.size,
				entries: moved
			});
		}

		if (changed) {
			this.#reindexBuiltinsLast();
			await this.persistActivities();
		}
	}

	/**
	 * Einträge aller Monate von `oldIds` auf `toId` umhängen. Liefert die Anzahl.
	 *
	 * Muss VOR dem Löschen der alten Zeilen laufen: sonst zeigen die Einträge auf
	 * eine Aktivität, die es nicht mehr gibt, und heissen in der Liste "(gelöscht)".
	 */
	async #repointEntries(oldIds: Set<string>, toId: string): Promise<number> {
		if (oldIds.size === 0) return 0;
		let moved = 0;

		for (const month of await listEntryMonths()) {
			await this.ensureMonth(month);
			const list = this.entriesByMonth[month];
			if (!list) continue;
			let touched = false;
			for (const e of list) {
				if (oldIds.has(e.activityId)) {
					e.activityId = toId;
					touched = true;
					moved++;
				}
			}
			if (touched) await this.#saveMonth(month);
		}

		if (this.running && oldIds.has(this.running.activityId)) this.running.activityId = toId;
		return moved;
	}

	async persistActivities(): Promise<void> {
		// Jeder Schreibvorgang läuft hier durch - Anlegen, Import, Umsortieren,
		// Löschen. Die Regel steht deshalb an dieser einen Stelle statt an jeder
		// davon.
		this.#reindexBuiltinsLast();
		await saveActivities($state.snapshot(this.activities) as Activity[]);
		this.trayVersion = (this.trayVersion + 1) % 1000;
		void notifyDataChanged();
	}

	/** Mehrere Aktivitätsnamen importieren (jede Zeile = eine). Bestehende bleiben. */
	async importActivities(names: string[]): Promise<number> {
		const existing = new Set(this.activities.map((a) => a.name.toLowerCase()));
		let added = 0;
		let order = this.activities.length;
		for (const raw of names) {
			const name = raw.trim();
			if (!name || existing.has(name.toLowerCase())) continue;
			existing.add(name.toLowerCase());
			this.activities.push({
				id: uid(),
				name,
				sortOrder: order++,
				archived: false,
				isAbsence: false
			});
			added++;
		}
		if (added) await this.persistActivities();
		return added;
	}

	#reindexBuiltinsLast(): void {
		[...this.activities].sort(byActivityOrder).forEach((a, i) => (a.sortOrder = i));
	}

	/**
	 * Legt eine Aktivität an und liefert deren id. Existiert bereits eine (nicht
	 * archivierte) Aktivität mit gleichem Namen, wird deren id zurückgegeben statt
	 * ein Duplikat anzulegen. Liefert null bei leerem Namen.
	 */
	async addActivity(name: string): Promise<string | null> {
		const trimmed = name.trim();
		if (!trimmed) return null;
		const existing = this.activities.find(
			(a) => !a.archived && a.name.toLowerCase() === trimmed.toLowerCase()
		);
		if (existing) return existing.id;
		const id = uid();
		this.activities.push({
			id,
			name: trimmed,
			sortOrder: this.activities.length,
			archived: false,
			isAbsence: false
		});
		this.#reindexBuiltinsLast();
		await this.persistActivities();
		return id;
	}

	/** Umbenennen – ausser bei den eingebauten Zeilen. */
	async renameActivity(id: string, name: string): Promise<void> {
		const a = this.activities.find((x) => x.id === id);
		if (!a || isBuiltinActivity(a)) return;
		a.name = name.trim() || a.name;
		await this.persistActivities();
	}

	async toggleFavorite(id: string): Promise<void> {
		const a = this.activities.find((x) => x.id === id);
		if (a) {
			a.favorite = !a.favorite;
			await this.persistActivities();
		}
	}

	async setColor(id: string, color: string | null): Promise<void> {
		const a = this.activities.find((x) => x.id === id);
		if (!a) return;
		if (color) a.color = color;
		else delete a.color;
		await this.persistActivities();
	}

	activityColor(id: string): string | undefined {
		return this.activities.find((a) => a.id === id)?.color;
	}

	async setShortcut(id: string, accelerator: string | null): Promise<void> {
		const a = this.activities.find((x) => x.id === id);
		if (!a) return;
		if (accelerator) a.shortcut = accelerator;
		else delete a.shortcut;
		await this.persistActivities();
	}

	get hasFavorites(): boolean {
		return this.activities.some((a) => a.favorite && !a.archived && !a.isAbsence);
	}

	/** Aus der Auswahl ausblenden – erscheint aber weiterhin im Bericht/E-Mail. */
	async toggleHidden(id: string): Promise<void> {
		const a = this.activities.find((x) => x.id === id);
		if (a && !isBuiltinActivity(a)) {
			a.hidden = !a.hidden;
			await this.persistActivities();
		}
	}

	async setArchived(id: string, archived: boolean): Promise<void> {
		const a = this.activities.find((x) => x.id === id);
		if (a && !isBuiltinActivity(a)) {
			a.archived = archived;
			await this.persistActivities();
		}
	}

	/** Zählt ALLE Einträge dieser Aktivität über alle Monate (lädt fehlende Monate nach). */
	async countActivityEntries(id: string): Promise<number> {
		let count = 0;
		for (const m of await listEntryMonths()) {
			await this.ensureMonth(m);
			count += (this.entriesByMonth[m] ?? []).filter((e) => e.activityId === id).length;
		}
		return count;
	}

	/**
	 * Löscht eine Aktivität UND alle ihre Einträge über alle Monate unwiderruflich.
	 * "Others"/"Abwesenheiten" sind geschützt. Liefert die Zahl gelöschter Einträge.
	 */
	async deleteActivity(id: string): Promise<number> {
		const a = this.activities.find((x) => x.id === id);
		if (!a || isBuiltinActivity(a)) return 0;

		let removed = 0;
		for (const m of await listEntryMonths()) {
			await this.ensureMonth(m);
			const list = this.entriesByMonth[m];
			if (!list) continue;
			const kept = list.filter((e) => e.activityId !== id);
			if (kept.length !== list.length) {
				removed += list.length - kept.length;
				this.entriesByMonth[m] = kept;
				await this.#saveMonth(m);
			}
		}
		if (this.running?.activityId === id) this.running = null;
		const name = a.name;
		this.activities = this.activities.filter((x) => x.id !== id);
		await this.persistActivities();
		// Unwiderruflich – hinterher will man wissen, was da genau verschwunden ist.
		logWarn(`Aktivität gelöscht: ${name}`, { id, entries: removed });
		return removed;
	}

	/**
	 * Alle Einträge einer Aktivität auf eine andere umhängen und die alte
	 * entfernen - nichts geht verloren, nur die eigene Zeile verschwindet.
	 *
	 * Für "meine Aktivität mit der neu angekommenen Team-Aktivität
	 * zusammenführen", funktioniert aber für zwei beliebige (nicht eingebaute)
	 * Zeilen. Liefert die Zahl umgehängter Einträge, 0 wenn nichts zu tun war.
	 */
	async mergeActivityInto(fromId: string, toId: string): Promise<number> {
		if (fromId === toId) return 0;
		const from = this.activities.find((x) => x.id === fromId);
		const to = this.activities.find((x) => x.id === toId);
		if (!from || !to || isBuiltinActivity(from) || isBuiltinActivity(to)) return 0;

		const moved = await this.#repointEntries(new Set([fromId]), toId);
		this.activities = this.activities.filter((x) => x.id !== fromId);
		await this.persistActivities();
		logWarn(`Aktivität zusammengeführt: "${from.name}" → "${to.name}"`, { moved });
		return moved;
	}

	/**
	 * Team-Zeilen aus der gemeinsamen Verwaltung lösen, aber als eigene,
	 * archivierte Aktivität behalten. Reines Entfernen liesse ihre schon
	 * erfassten Stunden lautlos aus dem Bericht verschwinden - der baut seine
	 * Zeilen nur aus der aktuellen activities-Liste auf (report.ts).
	 * Neue Id je Zeile, Einträge und Stichwortregeln ziehen mit: dieselbe
	 * Server-Id kann nach einem erneuten Beitritt wiederkommen, und zwei Zeilen
	 * mit derselben Id zählten ihre Stunden doppelt.
	 */
	async detachTeamActivities(which: (a: Activity) => boolean): Promise<void> {
		const teamOwned = this.activities.filter((a) => a.teamOwned && which(a));
		if (teamOwned.length === 0) return;
		const idMap = new Map(teamOwned.map((a) => [a.id, uid()]));

		for (const m of await listEntryMonths()) {
			await this.ensureMonth(m);
			const list = this.entriesByMonth[m];
			if (!list) continue;
			let touched = false;
			for (const e of list) {
				const newId = idMap.get(e.activityId);
				if (newId) {
					e.activityId = newId;
					touched = true;
				}
			}
			if (touched) await this.#saveMonth(m);
		}
		if (this.running) {
			const newId = idMap.get(this.running.activityId);
			if (newId) this.running.activityId = newId;
		}

		this.activities = this.activities.map((a) => {
			const newId = idMap.get(a.id);
			if (!newId) return a;
			const { teamOwned: _teamOwned, teamName: _teamName, teamId: _teamId, ...rest } = a;
			return { ...rest, id: newId, archived: true };
		});
		await this.persistActivities();

		// Kalender-Stichwortregeln zeigen sonst weiter auf die alte Team-Id - die
		// Zuordnung würde beim nächsten Import lautlos verstummen, ohne dass
		// jemand sähe, warum.
		let keywordsChanged = false;
		const remappedKeywords: Record<string, string> = {};
		for (const [kw, id] of Object.entries(this.settings.calendarKeywordMap)) {
			const newId = idMap.get(id);
			remappedKeywords[kw] = newId ?? id;
			if (newId) keywordsChanged = true;
		}
		if (keywordsChanged) await this.updateSettings({ calendarKeywordMap: remappedKeywords });
	}

	/** Verschiebt `draggedId` vor/hinter `targetId` (Drag & Drop). */
	async reorderActivity(draggedId: string, targetId: string, placeAfter = false): Promise<void> {
		if (draggedId === targetId) return;
		const reordered = reorderBySortOrder(this.activities, draggedId, targetId, placeAfter);
		if (!reordered) return;
		this.activities = reordered;
		await this.persistActivities();
	}

	async moveActivity(id: string, dir: -1 | 1): Promise<void> {
		const list = this.visibleActivities;
		const idx = list.findIndex((a) => a.id === id);
		const swap = idx + dir;
		if (idx < 0 || swap < 0 || swap >= list.length) return;
		const a = list[idx];
		const b = list[swap];
		const tmp = a.sortOrder;
		a.sortOrder = b.sortOrder;
		b.sortOrder = tmp;
		await this.persistActivities();
	}

	// ---------- Einträge ----------
	/** Laufende Ladevorgänge je Monat. */
	#loadingMonths = new Map<string, Promise<void>>();

	/**
	 * Einen Monat erst vom Server holen, wenn er hier noch fehlt.
	 *
	 * Setzt der Abgleich beim Start (siehe `setMonthFetcher`). Als Haken und nicht
	 * als Import, weil der Abgleich seinerseits diese Datei braucht.
	 */
	#monthFetcher: ((month: string) => Promise<void>) | null = null;

	setMonthFetcher(fn: ((month: string) => Promise<void>) | null): void {
		this.#monthFetcher = fn;
	}

	async ensureMonth(month: string): Promise<void> {
		if (this.entriesByMonth[month]) return;
		let pending = this.#loadingMonths.get(month);
		if (!pending) {
			// Erst holen, dann lesen. Andersherum bliebe der leere Monat im Speicher
			// stehen, denn ensureMonth merkt sich auch ein leeres Ergebnis.
			pending = this.#fetchThenLoad(month).finally(() => {
				this.#loadingMonths.delete(month);
			});
			this.#loadingMonths.set(month, pending);
		}
		return pending;
	}

	async #fetchThenLoad(month: string): Promise<void> {
		try {
			await this.#monthFetcher?.(month);
		} catch (e) {
			// Kein Netz heisst nicht "kein Monat": was auf der Platte liegt, gilt.
			logWarn(`Monat ${month} konnte nicht vom Server geholt werden`, e);
		}
		this.entriesByMonth[month] = await loadEntries(month);
	}

	monthEntries(month: string): Entry[] {
		return this.entriesByMonth[month] ?? [];
	}

	/** Ist dieser Monat bereits geladen? */
	monthLoaded(month: string): boolean {
		return this.entriesByMonth[month] !== undefined;
	}

	/**
	 * Alle Einträge eines Jahres endgültig löschen.
	 * Der Cache muss mit: sonst zeigte die App Einträge weiter an, die es auf der
	 * Platte nicht mehr gibt. Ein laufender Timer in dem Jahr wird vorher gestoppt.
	 */
	async deleteYearEntries(year: number): Promise<number> {
		const deleted = await deleteYear(year);
		logWarn(`Jahr ${year} gelöscht`, { months: deleted });
		for (const m of deleted) delete this.entriesByMonth[m];
		if (this.running && monthKey(this.running.startTs).startsWith(`${year}-`)) {
			this.running = null;
		}
		this.entriesVersion++;
		return deleted.length;
	}

	async #saveMonth(month: string): Promise<void> {
		const list = this.entriesByMonth[month];
		// Kein Cache-Eintrag heisst "nicht geladen", nicht "leer" - saveEntries
		// LOESCHT die Datei bei `[]`. Ohne diese Wache würde ein ungeladener
		// Monat still geleert.
		if (!list) return;
		await saveEntries(month, $state.snapshot(list) as Entry[]);
		// Einziger Weg, auf dem Einträge auf die Platte kommen – deshalb sitzt das
		// Signal hier und nicht bei den Aufrufern.
		this.entriesVersion++;
		void notifyDataChanged();
	}

	/** Ganztags-Abwesenheit an diesem Tag, falls vorhanden. */
	#findFullDayAbsence(ts: number): Entry | undefined {
		const absId = this.absenceActivity?.id;
		if (!absId) return undefined;
		const key = fmtDate(ts);
		return this.monthEntries(monthKey(ts)).find(
			(e) => e.activityId === absId && (e.dayFraction ?? 1) >= 1 && fmtDate(e.startTs) === key
		);
	}

	/** Ganztags-Abwesenheit an diesem Tag vorhanden? (Tagesanteil >= 1) */
	hasFullDayAbsence(ts: number): boolean {
		return !!this.#findFullDayAbsence(ts);
	}

	/**
	 * Sammelt die Ganztags-Abwesenheiten, auf die die übergebenen Tage treffen
	 * (dedupliziert nach Abwesenheits-Eintrag). Für die Folgetage einer
	 * Mitternachts-Teilung, die #reportConflict (nur der erste Tag) nicht sieht.
	 */
	#collectBlockedDays(parts: { startTs: number }[]): BlockedDay[] {
		const out: BlockedDay[] = [];
		const seen = new Set<string>();
		for (const p of parts) {
			const abs = this.#findFullDayAbsence(p.startTs);
			if (abs && !seen.has(abs.id)) {
				seen.add(abs.id);
				out.push({ entry: abs, date: fmtDate(p.startTs), activityName: this.activityName(abs.activityId) });
			}
		}
		return out;
	}

	/** Projekt-(Nicht-Abwesenheits-)Eintrag an diesem Tag vorhanden? */
	hasProjectEntry(ts: number): boolean {
		const key = fmtDate(ts);
		return this.monthEntries(monthKey(ts)).some(
			(e) => !this.isAbsenceId(e.activityId) && fmtDate(e.startTs) === key
		);
	}

	/**
	 * Eintrag anlegen. Geht er über Mitternacht, entsteht je Tag einer – dieselbe
	 * Regel wie beim Timer: sonst zählte die Zeit nach 00:00 zum Vortag und an
	 * einer Monatsgrenze im falschen Bericht.
	 *
	 * @returns das erste Tagesstück, oder null wenn nichts angelegt wurde
	 */
	async addEntry(
		activityId: string,
		startTs: number,
		endTs: number | null,
		note = "",
		source: EntrySource = "manual",
		dayFraction?: number,
		opts: { confirmAbsenceOverride?: boolean; timeOff?: boolean } = {}
	): Promise<Entry | null> {
		await this.ensureMonth(monthKey(startTs));
		if (endTs !== null) await this.ensureMonth(monthKey(endTs));

		// Regel: Ganztags-Abwesenheit und Projektzeit am selben Tag schließen sich aus.
		if (this.#reportConflict({ activityId, startTs, endTs, dayFraction })) return null;

		// Abwesenheiten sind tagesgenau (start == end == Tagesmitte), ein laufender
		// Timer hat noch kein Ende – beide können nicht über Mitternacht gehen.
		const parts =
			endTs === null || dayFraction != null
				? [{ startTs, endTs }]
				: splitAtMidnight(startTs, endTs);

		// #reportConflict prüft nur den ERSTEN Tag. Ein Folgetag aus der Teilung
		// kann trotzdem auf eine Ganztags-Abwesenheit treffen – ohne diese Wache
		// entstünde dort still Projektzeit (dieselbe Regel, die #addSegment für
		// den Timer-Pfad schon durchsetzt). Interaktive Aufrufer können per
		// opts.confirmAbsenceOverride stattdessen eine Rückfrage anbieten, die
		// die Abwesenheit entfernt statt einfach abzulehnen (siehe confirmAbsenceOverride).
		if (parts.length > 1) {
			const blocked = this.#collectBlockedDays(parts.slice(1));
			if (blocked.length > 0) {
				if (!opts.confirmAbsenceOverride) {
					toast.error(
						`Am ${fmtDateHuman(blocked[0].entry.startTs)} ist eine Ganztags-Abwesenheit eingetragen.`
					);
					return null;
				}
				this.absenceOverridePrompt = {
					kind: "add",
					args: { activityId, startTs, endTs, note, source, dayFraction, timeOff: opts.timeOff },
					days: blocked
				};
				return null;
			}
		}

		let first: Entry | null = null;
		for (const p of parts) {
			const e = await this.#pushEntry(
				activityId,
				p.startTs,
				p.endTs,
				note,
				source,
				dayFraction,
				opts.timeOff
			);
			first ??= e;
		}
		return first;
	}

	/** Einen Eintrag ohne weitere Prüfung anlegen und speichern. */
	async #pushEntry(
		activityId: string,
		startTs: number,
		endTs: number | null,
		note: string,
		source: EntrySource,
		dayFraction?: number,
		timeOff?: boolean
	): Promise<Entry> {
		const month = monthKey(startTs);
		await this.ensureMonth(month);
		const entry: Entry = { id: uid(), activityId, startTs, endTs, note, source };
		if (dayFraction != null) entry.dayFraction = dayFraction;
		// Nur setzen, wo es zutrifft: ein `timeOff: false` an jedem Eintrag wäre
		// eine inhaltliche Änderung und schickte den halben Bestand erneut hoch.
		if (timeOff) entry.timeOff = true;
		this.entriesByMonth[month].push(entry);
		await this.#saveMonth(month);
		return entry;
	}

	/** Zeitausgleich statt Urlaub/Krank? Nur auf der Abwesenheits-Zeile möglich. */
	isTimeOff(e: Entry): boolean {
		return e.timeOff === true && this.isAbsenceId(e.activityId);
	}

	isAbsenceId(activityId: string): boolean {
		return !!this.activities.find((a) => a.id === activityId)?.isAbsence;
	}

	/**
	 * Aktivitäten für die Timer-Auswahl: ohne Abwesenheiten und ohne ausgeblendete,
	 * Favoriten zuerst, dann nach Reihenfolge.
	 */
	get trackableActivities(): Activity[] {
		return this.visibleActivities
			.filter((a) => !a.isAbsence && !a.hidden)
			.sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || byActivityOrder(a, b));
	}

	/** Die zuletzt genutzten trackbaren Aktivitäten (für Tray-Schnellstart). */
	recentActivities(limit = 3): Activity[] {
		const all: Entry[] = [];
		for (const list of Object.values(this.entriesByMonth)) all.push(...list);
		all.sort((a, b) => b.startTs - a.startTs);
		const seen = new Set<string>();
		const result: Activity[] = [];
		for (const e of all) {
			if (seen.has(e.activityId) || this.isAbsenceId(e.activityId)) continue;
			const act = this.activities.find((a) => a.id === e.activityId && !a.archived && !a.hidden);
			if (act) {
				seen.add(e.activityId);
				result.push(act);
			}
			if (result.length >= limit) break;
		}
		for (const act of this.trackableActivities) {
			if (result.length >= limit) break;
			if (!seen.has(act.id)) {
				seen.add(act.id);
				result.push(act);
			}
		}
		return result.slice(0, limit);
	}

	/** Schnellstart-Liste: Favoriten zuerst, dann mit den zuletzt benutzten aufgefüllt. */
	quickActivities(limit: number): Activity[] {
		const seen = new Set<string>();
		const out: Activity[] = [];
		const favorites = this.trackableActivities.filter((a) => a.favorite);
		for (const a of [...favorites, ...this.recentActivities(limit)]) {
			if (seen.has(a.id)) continue;
			seen.add(a.id);
			out.push(a);
		}
		return out.slice(0, limit);
	}

	/**
	 * Prüft die Tagesregel (Ganztags-Abwesenheit ⊥ Projektzeit) für einen Eintrag,
	 * ohne den Eintrag selbst (`excludeId`) mitzuzählen. true = Konflikt.
	 */
	#reportConflict(candidate: {
		activityId: string;
		startTs: number;
		endTs?: number | null;
		dayFraction?: number;
		id?: string;
		/** true = Zeiten unverändert, Überschneidung nicht neu prüfen */
		skipOverlap?: boolean;
	}): boolean {
		// Ein Kandidat kann über Mitternacht bis in einen anderen Monat reichen
		// (Monatsletzter -> Monatserster). dayConflict interessiert sich ohnehin
		// nur für den Tag von candidate.startTs, filtert also unpassende
		// endMonth-Einträge selbst heraus – overlapConflict braucht die vollständige
		// Liste, sonst übersähe es eine Überschneidung am Monatsanfang.
		const startMonth = monthKey(candidate.startTs);
		const endMonth = candidate.endTs != null ? monthKey(candidate.endTs) : startMonth;
		const monthEntries =
			startMonth === endMonth
				? this.monthEntries(startMonth)
				: [...this.monthEntries(startMonth), ...this.monthEntries(endMonth)];
		const conflict = dayConflict(monthEntries, candidate, this.absenceActivity?.id, {
			excludeId: candidate.id
		});
		if (conflict === "full-day-absence") {
			toast.error(`Am ${fmtDateHuman(candidate.startTs)} ist eine Ganztags-Abwesenheit eingetragen.`);
			return true;
		}
		if (conflict === "project-time") {
			toast.error(
				`Am ${fmtDateHuman(candidate.startTs)} gibt es Projektzeiten – nur halber Urlaubstag möglich.`
			);
			return true;
		}

		// Man kann nicht gleichzeitig an zwei Dingen arbeiten.
		if (candidate.skipOverlap) return false;
		const absenceIds = new Set(this.activities.filter((a) => a.isAbsence).map((a) => a.id));
		const overlap = overlapConflict(
			monthEntries,
			{ activityId: candidate.activityId, startTs: candidate.startTs, endTs: candidate.endTs ?? null },
			absenceIds,
			{ excludeId: candidate.id, now: this.now }
		);
		if (overlap) {
			const von = fmtClock(overlap.startTs);
			const bis = overlap.endTs ? fmtClock(overlap.endTs) : "läuft";
			toast.error(
				`Überschneidet sich mit „${this.activityName(overlap.activityId)}“ (${von}–${bis}).`
			);
			return true;
		}
		return false;
	}

	/** false = wegen Tageskonflikt nicht gespeichert. */
	async updateEntry(originalStartTs: number, updated: Entry): Promise<boolean> {
		const oldMonth = monthKey(originalStartTs);
		const newMonth = monthKey(updated.startTs);
		await this.ensureMonth(oldMonth);
		await this.ensureMonth(newMonth);
		// Kann von newMonth abweichen, wenn die Bearbeitung über einen Monatswechsel
		// reicht – #reportConflict braucht diesen Monat für den Überschneidungs-Check.
		if (updated.endTs != null) await this.ensureMonth(monthKey(updated.endTs));
		// Manche gespeicherten Einträge können die Überschneidungs-Regel bereits
		// verletzen. Wer nur die Notiz ändert, darf davon nicht ausgesperrt werden
		// – sonst bliebe für solche Einträge nur noch Löschen. Zeiten unverändert
		// -> keine neue Überschneidung möglich.
		const old = this.monthEntries(oldMonth).find((e) => e.id === updated.id);
		const timesUnchanged =
			!!old && old.startTs === updated.startTs && old.endTs === updated.endTs;
		if (this.#reportConflict({ ...updated, skipOverlap: timesUnchanged })) return false;

		// Über Mitternacht bearbeitet: der Eintrag behält den ersten Tag, die
		// weiteren Tage werden eigene Einträge – wie beim Anlegen und beim Timer.
		const rest =
			updated.endTs !== null && updated.dayFraction == null
				? splitAtMidnight(updated.startTs, updated.endTs).slice(1)
				: [];

		// Wie bei addEntry: #reportConflict sieht nur den ersten Tag. Ein Folgetag
		// kann auf eine Ganztags-Abwesenheit treffen – dann erst fragen (siehe
		// confirmAbsenceOverride), statt still Projektzeit dort anzulegen.
		if (rest.length > 0) {
			const blocked = this.#collectBlockedDays(rest);
			if (blocked.length > 0) {
				this.absenceOverridePrompt = {
					kind: "update",
					originalStartTs,
					entry: { ...updated },
					days: blocked
				};
				return false;
			}
		}
		if (rest.length > 0) updated.endTs = startOfNextDay(updated.startTs);

		if (oldMonth === newMonth) {
			const list = this.entriesByMonth[oldMonth];
			const i = list.findIndex((e) => e.id === updated.id);
			if (i >= 0) list[i] = updated;
			await this.#saveMonth(oldMonth);
		} else {
			const oldList = this.entriesByMonth[oldMonth];
			const i = oldList.findIndex((e) => e.id === updated.id);
			if (i >= 0) oldList.splice(i, 1);
			this.entriesByMonth[newMonth].push(updated);
			await this.#saveMonth(oldMonth);
			await this.#saveMonth(newMonth);
		}

		for (const p of rest) {
			await this.#pushEntry(updated.activityId, p.startTs, p.endTs, updated.note, updated.source);
		}
		return true;
	}

	async deleteEntry(entry: Entry): Promise<void> {
		const month = monthKey(entry.startTs);
		await this.ensureMonth(month);
		const list = this.entriesByMonth[month];
		const i = list.findIndex((e) => e.id === entry.id);
		if (i >= 0) {
			list.splice(i, 1);
			await this.#saveMonth(month);
		}
		if (this.running?.id === entry.id) this.running = null;
	}

	/**
	 * Eine stehen gebliebene Mitternachts-Teilung aufloesen - siehe
	 * StaleTimerSplitDialog. `keep: "ended"` uebernimmt die echte, kuerzere
	 * Endzeit und loescht die Fortsetzung; `keep: "continuation"` verwirft die
	 * fremde Endzeit wieder und stellt den Bruecken-Uebergang zur Fortsetzung
	 * her, so wie die Teilung ihn urspruenglich angelegt hatte.
	 */
	async resolveStaleTimerSplit(
		info: StaleTimerSplitInfo,
		keep: "ended" | "continuation"
	): Promise<void> {
		if (keep === "ended") {
			await this.deleteEntry(info.continuationEntry);
		} else {
			await this.updateEntry(info.endedEntry.startTs, {
				...info.endedEntry,
				endTs: info.continuationEntry.startTs
			});
		}
	}

	// ---------- Timer ----------
	/** Alle aktuell offenen Einträge (endTs === null) über die geladenen Monate. */
	#openEntries(): Entry[] {
		const out: Entry[] = [];
		for (const list of Object.values(this.entriesByMonth)) {
			for (const e of list) if (e.endTs === null) out.push(e);
		}
		return out;
	}

	/** Die zusammenhängenden Stücke EINES Laufs, ältestes zuerst. */
	runChain(entry: Entry): Entry[] {
		const all = Object.values(this.entriesByMonth).flat();
		const chain = [entry];
		const seen = new Set([entry.id]);
		for (;;) {
			const cur = chain[0];
			const matching = all.filter(
				(e) =>
					!seen.has(e.id) &&
					e.activityId === cur.activityId &&
					startOfNextDay(e.startTs) === cur.startTs
			);
			// Das exakt anschliessende Stück gewinnt, ein offenes ist nur der
			// Rückfall. Beides in EINE Suche zu werfen machte das Ergebnis von der
			// Reihenfolge in der Monatsdatei abhängig: läge eine vergessene offene
			// Zeile vor dem echten Vorgänger, gewänne sie – und der Lauf sähe je
			// nach Dateireihenfolge anders aus.
			const prev =
				matching.find((e) => e.endTs === cur.startTs) ?? matching.find((e) => e.endTs === null);
			if (!prev) return chain;
			seen.add(prev.id);
			chain.unshift(prev);
		}
	}

	/** Beginn des laufenden Laufs – vor der Mitternachts-Teilung. Null = kein Timer. */
	get runStartTs(): number | null {
		return this.running ? this.runChain(this.running)[0].startTs : null;
	}

	/** Sekunden des laufenden LAUFS, über Mitternachts-Teilungen hinweg. */
	get runSeconds(): number {
		const start = this.runStartTs;
		return start === null ? 0 : Math.max(0, Math.floor((this.now - start) / 1000));
	}

	/** Schließt ALLE offenen Einträge (egal welches Fenster sie öffnete). running = null. */
	async #closeAllOpen(endTs = Date.now()): Promise<void> {
		const openOnes = this.#openEntries();
		if (openOnes.length > 0) {
			logInfo(`Timer gestoppt: ${openOnes.map((e) => this.activityName(e.activityId)).join(", ")}`, {
				end: new Date(endTs).toISOString(),
				seconds: openOnes.map((e) => Math.round((Math.max(e.startTs, endTs) - e.startTs) / 1000))
			});
		}
		// Der ganze Lauf, nicht nur das letzte Tagesstück: eine Endzeit vor
		// Mitternacht muss die schon abgetrennten Stücke mitnehmen.
		const chains = openOnes.map((open) => this.runChain(open)).sort((a, b) => b.length - a.length);
		const done = new Set<string>();

		const months = new Set<string>();
		for (const chain of chains) {
			// Nie vor den Beginn des Laufs – sonst entstünde eine negative Dauer.
			const end = Math.max(chain[0].startTs, endTs);
			for (let i = 0; i < chain.length; i++) {
				const piece = chain[i];
				if (done.has(piece.id)) continue;
				done.add(piece.id);
				// Ein Stück endet spätestens dort, wo das nächste des Laufs beginnt.
				// Sonst zerlegte ein offen gebliebenes Vorgängerstück den Folgetag
				// noch einmal – neben dem Stück, das ihn schon abdeckt.
				const bis = Math.min(end, chain[i + 1]?.startTs ?? end);
				const m = monthKey(piece.startTs);
				months.add(m);
				// Stücke komplett nach dem Ende gab es nie. Das erste bleibt, damit
				// ein Lauf nicht spurlos verschwindet (dann eben mit Dauer 0).
				if (piece.id !== chain[0].id && piece.startTs >= end) {
					const list = this.entriesByMonth[m];
					const k = list?.findIndex((x) => x.id === piece.id) ?? -1;
					if (k >= 0) list.splice(k, 1);
					continue;
				}
				if (piece.endTs !== null && piece.endTs <= bis) continue;
				// Über Mitternacht in Tagesstücke zerlegen: sonst zählte die Zeit
				// nach 00:00 zum Vortag – an einer Monatsgrenze sogar in der falschen
				// Monatsdatei und damit im falschen Bericht.
				const parts = splitAtMidnight(piece.startTs, Math.max(piece.startTs, bis));
				piece.endTs = parts[0].endTs;
				for (const p of parts.slice(1)) {
					const seg = await this.#addSegment(piece, p.startTs, p.endTs);
					if (seg) months.add(seg);
				}
			}
		}
		this.running = null;
		for (const m of months) await this.#saveMonth(m);
		// Tray-Icon und -Menü aktualisieren, nachdem running stabil null ist.
		this.trayVersion = (this.trayVersion + 1) % 1000;
	}

	/**
	 * Folgetag-Stück eines geteilten Eintrags anlegen; liefert dessen Monat –
	 * oder null, wenn der Tag eine Ganztags-Abwesenheit trägt.
	 */
	async #addSegment(from: Entry, startTs: number, endTs: number | null): Promise<string | null> {
		const m = monthKey(startTs);
		await this.ensureMonth(m);
		if (this.hasFullDayAbsence(startTs)) return null;
		this.entriesByMonth[m].push({
			id: uid(),
			activityId: from.activityId,
			startTs,
			endTs,
			note: from.note,
			source: from.source
		});
		return m;
	}

	/**
	 * Läuft der Timer über Mitternacht, wird er dort beendet und am neuen Tag
	 * fortgesetzt. Läuft jede Sekunde mit – der Datumsvergleich hält das billig.
	 */
	async #rolloverAtMidnight(): Promise<void> {
		if (!this.running || fmtDate(this.running.startTs) === fmtDate(Date.now())) return;
		await this.#exclusive(async () => {
			// Nach dem Anstehen erneut prüfen: der Tick feuert im Sekundentakt.
			const cur = this.running;
			if (!cur || fmtDate(cur.startTs) === fmtDate(Date.now())) return;
			const parts = splitAtMidnight(cur.startTs, Date.now());
			if (parts.length < 2) return;

			const months = new Set<string>([monthKey(cur.startTs)]);
			cur.endTs = parts[0].endTs;
			// Zwischentage entstehen, wenn die App durchlief; das letzte Stück läuft weiter.
			for (const p of parts.slice(1, -1)) {
				const seg = await this.#addSegment(cur, p.startTs, p.endTs);
				if (seg) months.add(seg);
			}

			const last = parts[parts.length - 1];
			const m = monthKey(last.startTs);
			await this.ensureMonth(m);
			// Idempotent: gibt es für diese Aktivität schon einen offenen Eintrag
			// exakt ab dieser Mitternacht, lief der Wechsel bereits. Sonst entstünde
			// ein zweiter – zwei offene Einträge mit identischem Start, die später
			// beide geschlossen werden und als Duplikat in der Liste stehen.
			if (
				this.#openEntries().some(
					(e) => e.id !== cur.id && e.activityId === cur.activityId && e.startTs === last.startTs
				)
			) {
				for (const mm of months) await this.#saveMonth(mm);
				return;
			}
			// An einem Ganztags-Abwesenheitstag gibt es keine Projektzeit – dort endet
			// der Timer an der Tagesgrenze, statt die Regel zu umgehen.
			if (this.hasFullDayAbsence(last.startTs)) {
				this.running = null;
				for (const mm of months) await this.#saveMonth(mm);
				toast.info(
					`Timer um Mitternacht beendet: am ${fmtDateHuman(last.startTs)} ist eine Ganztags-Abwesenheit eingetragen.`
				);
				return;
			}
			const next: Entry = {
				id: uid(),
				activityId: cur.activityId,
				startTs: last.startTs,
				endTs: null,
				note: cur.note,
				source: cur.source
			};
			this.entriesByMonth[m].push(next);
			this.running = next;
			months.add(m);
			for (const mm of months) await this.#saveMonth(mm);
			logInfo(`Timer über Mitternacht geteilt: ${this.activityName(cur.activityId)}`, {
				days: parts.length,
				continueFrom: new Date(last.startTs).toISOString()
			});
		});
	}

	/**
	 * Den laufenden Eintrag bestimmen: der neueste offene. Ältere offene bleiben
	 * zurück, wenn die App abgestürzt ist oder ein Start den vorherigen nicht
	 * sauber beendet hat – die müssen geschlossen werden, sonst laufen sie ewig.
	 */
	async #findRunning(): Promise<void> {
		const open = this.#openEntries().sort((a, b) => b.startTs - a.startTs);
		this.running = open[0] ?? null;
		if (open.length <= 1) return;

		const months = new Set<string>();
		let estimated = 0;
		// open[i-1] ist der nächstjüngere: dessen Start beendete open[i].
		for (let i = 1; i < open.length; i++) {
			const e = open[i];
			const end = Math.min(open[i - 1].startTs, startOfNextDay(e.startTs));
			e.endTs = Math.max(e.startTs, end);
			if (e.endTs > e.startTs) estimated++;
			months.add(monthKey(e.startTs));
		}
		for (const m of months) await this.#saveMonth(m);

		// Melden statt still korrigieren: die Zeiten sind geraten, nur der Benutzer
		// weiss, ob sie stimmen.
		if (estimated > 0) {
			logWarn(`${estimated} offene Einträge geschätzt geschlossen`, {
				entries: open.slice(1).map((e) => ({
					activity: this.activityName(e.activityId),
					von: new Date(e.startTs).toISOString(),
					bis: e.endTs ? new Date(e.endTs).toISOString() : null
				}))
			});
			toast.warning(
				estimated === 1
					? "Ein Eintrag lief noch – das Ende wurde geschätzt. Bitte prüfen."
					: `${estimated} Einträge liefen noch – die Enden wurden geschätzt. Bitte prüfen.`
			);
		}
	}

	/**
	 * Serialisiert Timer-Mutationen (Start/Stop/Toggle), damit zwei schnelle
	 * Klicks/Hotkeys nicht zwei laufende Einträge erzeugen.
	 */
	#timerOp: Promise<unknown> = Promise.resolve();
	#exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.#timerOp.then(fn, fn);
		this.#timerOp = next.then(
			() => undefined,
			() => undefined
		);
		return next;
	}

	async #startInternal(activityId: string, startTs?: number): Promise<void> {
		// Abwesenheiten werden nicht per Timer erfasst, sondern als Tage im Einträge-Tab.
		if (this.isAbsenceId(activityId)) return;
		// Läuft genau diese Aktivität schon? -> nichts tun (kein zweiter Eintrag).
		if (this.running?.activityId === activityId) return;
		const now = Date.now();
		// Rückdatierter Start: nie in der Zukunft.
		const start = Math.min(startTs ?? now, now);

		// Laden VOR dem Prüfen: monthEntries liefert für einen ungeladenen Monat
		// [], jede Wache ginge sonst still durch. Ein über den Monatswechsel
		// offenes Fenster hat den aktuellen Monat nicht zwingend geladen.
		await this.#ensureSpan(start);

		if (this.hasFullDayAbsence(start)) {
			// Den Tag benennen: bei rückdatiertem Start kann das der VORTAG sein
			// (kurz nach Mitternacht "vor 60 Min"). "An diesem Tag" liess einen dann
			// auf heute schauen, wo gar keine Abwesenheit steht.
			toast.error(
				`Am ${fmtDateHuman(start)} ist eine Ganztags-Abwesenheit eingetragen – dort kann kein Timer beginnen.`
			);
			return;
		}

		// Abgeschlossene Zeiten anzufassen ist eine Ansage – dafür wird gefragt.
		// Einen laufenden Timer zu kürzen ist der normale Wechsel, das läuft still.
		if (planNeedsConfirm(this.#planFor(start))) {
			this.backdatePrompt = { activityId, start, plan: this.#planFor(start) };
			return;
		}
		await this.#applyStart(activityId, start);
	}

	/** Beide Enden von [start, jetzt] laden – bei Rückdatierung über einen
	 *  Monatswechsel liegen sie in verschiedenen Dateien. */
	async #ensureSpan(start: number): Promise<void> {
		await this.ensureMonth(monthKey(start));
		await this.ensureMonth(monthKey(Date.now()));
	}

	#planFor(start: number): BackdatePlan {
		return planBackdate(
			Object.values(this.entriesByMonth).flat(),
			start,
			new Set(this.activities.filter((a) => a.isAbsence).map((a) => a.id)),
			Date.now()
		);
	}

	/** Plan anwenden und den Timer setzen. */
	async #applyStart(activityId: string, start: number): Promise<void> {
		await this.#ensureSpan(start);
		const plan = this.#planFor(start);
		const month = monthKey(start);

		// Wechsel ohne Flackern: alte Einträge anpassen UND neuen setzen in EINEM
		// synchronen Schritt (kein await dazwischen -> running wird nie kurz null).
		const months = new Set<string>();
		// Tagesstücke der Kürzung erst nach dem synchronen Block anlegen (#addSegment
		// ist async). Ein offener Eintrag von vorgestern, der jetzt gekürzt wird, ergäbe
		// sonst EINEN Eintrag über mehrere Tage – im Bericht eine 50-Stunden-Zeile.
		const followUps: { from: Entry; startTs: number; endTs: number }[] = [];
		for (const { entry, endTs } of plan.truncate) {
			const parts = splitAtMidnight(entry.startTs, endTs);
			entry.endTs = parts[0].endTs;
			for (const p of parts.slice(1)) followUps.push({ from: entry, ...p });
			months.add(monthKey(entry.startTs));
		}
		for (const dead of plan.remove) {
			const m = monthKey(dead.startTs);
			const list = this.entriesByMonth[m];
			const i = list?.findIndex((e) => e.id === dead.id) ?? -1;
			if (i >= 0) list.splice(i, 1);
			months.add(m);
		}

		// Alle bisher noch offenen Einträge verlässlich schließen, bevor der neue startet.
		// Einträge, die planBackdate bereits in truncate/remove erfasst hat, überspringen –
		// sonst wird endTs zweimal gesetzt (einmal oben, einmal hier).
		const alreadyRecorded = new Set([
			...plan.truncate.map((t) => t.entry.id),
			...plan.remove.map((r) => r.id)
		]);
		for (const open of this.#openEntries()) {
			if (alreadyRecorded.has(open.id)) continue;
			const parts = splitAtMidnight(open.startTs, start);
			open.endTs = parts[0].endTs;
			for (const p of parts.slice(1)) followUps.push({ from: open, ...p });
			months.add(monthKey(open.startTs));
		}

		const entry: Entry = { id: uid(), activityId, startTs: start, endTs: null, note: "", source: "timer" };
		this.entriesByMonth[month].push(entry);
		this.running = entry;
		months.add(month);

		for (const f of followUps) {
			const seg = await this.#addSegment(f.from, f.startTs, f.endTs);
			if (seg) months.add(seg);
		}

		// Persistieren erst danach (beeinflusst die UI nicht mehr).
		for (const m of months) await this.#saveMonth(m);
		// Tray-Icon und -Menü aktualisieren, nachdem running stabil auf den neuen
		// Eintrag zeigt (kein Zwischenzustand null → running).
		this.trayVersion = (this.trayVersion + 1) % 1000;
		logInfo(`Timer gestartet: ${this.activityName(activityId)}`, {
			start: new Date(start).toISOString(),
			backdated: Date.now() - start > 60_000 ? Math.round((Date.now() - start) / 60_000) : 0,
			trimmed: plan.truncate.length,
			removed: plan.remove.length
		});
	}

	/** Rückfrage bestätigen: Plan neu bilden und starten. */
	async confirmBackdate(): Promise<void> {
		const p = this.backdatePrompt;
		if (!p) return;
		this.backdatePrompt = null;
		await this.#exclusive(() => this.#applyStart(p.activityId, p.start));
	}

	/**
	 * Rückfrage bestätigen: die blockierenden Ganztags-Abwesenheiten entfernen
	 * und den ursprünglichen Aufruf danach unverändert wiederholen – die
	 * Wache greift dann nicht mehr, weil der Tag frei ist.
	 */
	async confirmAbsenceOverride(): Promise<void> {
		const p = this.absenceOverridePrompt;
		if (!p) return;
		this.absenceOverridePrompt = null;
		for (const d of p.days) await this.deleteEntry(d.entry);
		if (p.kind === "add") {
			await this.addEntry(
				p.args.activityId,
				p.args.startTs,
				p.args.endTs,
				p.args.note,
				p.args.source,
				p.args.dayFraction,
				{ confirmAbsenceOverride: true, timeOff: p.args.timeOff }
			);
		} else {
			await this.updateEntry(p.originalStartTs, p.entry);
		}
	}

	/** Startet einen Timer, optional rückdatiert (startTs in der Vergangenheit). */
	startActivity(activityId: string, startTs?: number): Promise<void> {
		return this.#exclusive(() => this.#startInternal(activityId, startTs));
	}

	/** Startet/stoppt den zuletzt benutzten Timer (für globalen Hotkey). */
	toggleLast(): Promise<void> {
		return this.#exclusive(async () => {
			if (this.running) {
				await this.#stopInternal();
				return;
			}
			const last = this.recentActivities(1)[0];
			if (last) await this.#startInternal(last.id);
		});
	}

	/**
	 * Legt Abwesenheits-Einträge für einen Datumsbereich an (inkl. beider Tage),
	 * optional ohne Wochenenden. Gibt die Anzahl angelegter Tage zurück.
	 */
	async addAbsenceRange(
		startDate: string,
		endDate: string,
		fraction = 1,
		timeOff = false
	): Promise<{ added: number; skipped: number }> {
		const abs = this.absenceActivity;
		if (!abs) return { added: 0, skipped: 0 };
		if (Number.isNaN(noonTs(startDate)) || Number.isNaN(noonTs(endDate)) || endDate < startDate) {
			return { added: 0, skipped: 0 };
		}
		let added = 0;
		let skipped = 0;
		// Über Kalendertage statt über einen Date-Cursor: der hängt an der Zone
		// des Geräts, und an einer Sommerzeit-Grenze trifft +24 h den falschen Tag.
		for (let date = startDate; date <= endDate; date = stepDate(date, 1)) {
			// Nur reguläre Arbeitstage; Wochenenden/freie Tage nicht als Abwesenheit buchen.
			if (!this.settings.workdays.includes(weekdayOfDate(date))) continue;
			const noon = noonTs(date);
			// Ganztags-Konflikt mit Projektzeit -> Tag still überspringen (kein Doppel-Toast).
			if (fraction >= 1 && this.hasProjectEntry(noon)) {
				skipped++;
				continue;
			}
			const e = await this.addEntry(abs.id, noon, noon, "", "manual", fraction, { timeOff });
			if (e) added++;
			else skipped++;
		}
		return { added, skipped };
	}

	async #stopInternal(endTs = Date.now()): Promise<void> {
		// Jeden offenen Eintrag schließen (nicht nur this.running).
		await this.#closeAllOpen(endTs);
	}

	stop(endTs = Date.now()): Promise<void> {
		return this.#exclusive(() => this.#stopInternal(endTs));
	}

	/** Sekunden des laufenden Timers (oder 0). */
	get runningSeconds(): number {
		if (!this.running) return 0;
		return Math.max(0, Math.floor((this.now - this.running.startTs) / 1000));
	}

	/**
	 * Aktuelle Pomodoro-Phase des laufenden Timers (oder null).
	 * Zyklus = Fokus + Pause; bei Pause = 0 gibt es nur die Fokus-Phase.
	 */
	get pomodoro(): { phase: "focus" | "break"; remaining: number; cycleIndex: number } | null {
		const s = this.settings;
		if (!s.pomodoroEnabled || !this.running || s.pomodoroMin <= 0) return null;
		const focus = s.pomodoroMin * 60;
		const brk = Math.max(0, s.pomodoroBreakMin) * 60;
		const cycle = focus + brk;
		const pos = this.runningSeconds % cycle;
		const cycleIndex = Math.floor(this.runningSeconds / cycle);
		if (brk > 0 && pos >= focus) {
			return { phase: "break", remaining: cycle - pos, cycleIndex };
		}
		return { phase: "focus", remaining: focus - pos, cycleIndex };
	}

	// ---------- Berichts-Status ----------
	isReportSent(month: string): boolean {
		return this.settings.reportSentMonths.includes(month);
	}

	/** Markiert einen Monat als erledigt (gesendet oder „nicht mehr erinnern“). */
	async markReportSent(month: string): Promise<void> {
		if (this.isReportSent(month)) return;
		await this.updateSettings({
			reportSentMonths: [...this.settings.reportSentMonths, month]
		});
	}

	/**
	 * Vormonat, falls wir bereits im Folgemonat sind, er Einträge hat und der
	 * Bericht noch nicht erledigt wurde – sonst null.
	 */
	get pendingReportMonth(): string | null {
		const prev = prevMonthKey();
		if (prev === this.currentMonth) return null;
		if (this.isReportSent(prev)) return null;
		if ((this.entriesByMonth[prev] ?? []).length === 0) return null;
		return prev;
	}

	// ---------- Einstellungen ----------
	/** Die Zeitzone des Kontos in Kraft setzen. */
	async #applyTimeZone(): Promise<void> {
		const stored = this.settings.timeZone;
		if (stored && setAppTimeZone(stored)) return;
		const fallback = systemTimeZone();
		setAppTimeZone(fallback);
		if (stored) logWarn(`Unbekannte Zeitzone „${stored}“, nutze ${fallback}`);
		this.settings = { ...this.settings, timeZone: fallback };
		await saveSettings($state.snapshot(this.settings) as Settings);
		logInfo("Zeitzone festgeschrieben", { zone: fallback });
	}

	async updateSettings(patch: Partial<Settings>): Promise<void> {
		this.settings = { ...this.settings, ...patch };
		// Sofort wirksam machen: alles Weitere in diesem Durchlauf rechnet sonst
		// noch gegen die alte Zone.
		if (patch.timeZone !== undefined) setAppTimeZone(patch.timeZone);
		await saveSettings($state.snapshot(this.settings) as Settings);
		// Mit Werten: „E-Mail war leer“ ist die Art Frage, die hinterher niemand
		// mehr beantworten kann. Die Einstellungen sind harmlos – kein Passwort,
		// keine Zeiten, nur die Konfiguration, die der Benutzer selbst sieht.
		logDebug("Einstellungen gespeichert", patch);
		void notifyDataChanged();
	}

	// ---------- Onboarding ----------
	/**
	 * Willkommensbildschirm abschliessen: übernimmt die eingegebenen Werte und
	 * schreibt settings.json (dadurch gilt der nächste Start nicht mehr als erster).
	 * Auch beim "Überspringen" (ggf. mit leerem patch) aufrufen.
	 */
	async finishOnboarding(patch: Partial<Settings>): Promise<void> {
		await this.updateSettings(patch);
		this.showOnboarding = false;
	}

	/** Den Willkommensbildschirm weglegen, OHNE etwas zu schreiben. */
	dismissOnboarding(): void {
		this.showOnboarding = false;
	}

	/** Willkommensbildschirm erneut öffnen (Dev-Re-Trigger). */
	openOnboarding(): void {
		this.showOnboarding = true;
	}

	/**
	 * Dev: den Ladebildschirm vorführen – Start wiederholen und dabei am Schritt
	 * `step` scheitern ("error") oder hängen bleiben ("hang").
	 */
	async devSimulateStartFault(mode: "error" | "hang", step = "Einträge"): Promise<void> {
		logInfo(`Dev-Test: Ladebildschirm (${mode}) bei Schritt „${step}“`);
		this.devFail = { step, mode };
		this.initError = null;
		this.initStep = null;
		this.loaded = false;
		await this.init();
	}
}

export const app = new AppState();
