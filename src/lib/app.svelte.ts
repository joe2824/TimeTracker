// Zentraler, reaktiver App-Zustand (Svelte 5 Runes).
import { toast } from "svelte-sonner";
import type { Activity, Entry, EntrySource, Settings } from "./types";
import { BUILTIN_ABSENCE, BUILTIN_OTHERS, defaultSettings } from "./types";
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
} from "./time";
import { setAppTimeZone, systemTimeZone, weekdayOfDate } from "./tz";
import { dayConflict, overlapConflict } from "./conflicts";
import { planBackdate, planNeedsConfirm, type BackdatePlan } from "./backdate";
import { errorText, logDebug, logError, logInfo, logWarn } from "./log";
import { setErrorReportsEnabled } from "./analytics";
import {
	deleteYear,
	listEntryMonths,
	loadActivities,
	loadEntries,
	loadSettings,
	pruneEmptyMonthFiles,
	saveActivities,
	saveEntries,
	saveSettings,
	settingsFileExists
} from "./store";

function uid(): string {
	return crypto.randomUUID();
}

/** Wie lange ein vorgefuehrter Haenger stehen bleibt, bevor es weitergeht. */
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
	settings = $state<Settings>({ ...defaultSettings });
	/** laufender Eintrag (endTs === null) oder null */
	running = $state<Entry | null>(null);
	/** tickt jede Sekunde fuer Live-Dauer */
	now = $state(Date.now());
	loaded = $state(false);
	/** Woran der Start gerade arbeitet – der Ladebildschirm zeigt es an. */
	initStep = $state<string | null>(null);
	/** Start gescheitert: Schritt und Meldung fuer den Ladebildschirm. */
	initError = $state<{ step: string; message: string } | null>(null);
	/** true = Willkommensbildschirm anzeigen (erster Start oder Dev-Re-Trigger) */
	showOnboarding = $state(false);
	/** Versteckter Dev-Modus (ueber das Logo aktiviert). */
	devMode = $state(false);
	/**
	 * Dev: den naechsten Startschritt scheitern lassen ("error") oder aufhalten
	 * ("hang"), sobald sein Name `step` enthaelt. Siehe devSimulateStartFault().
	 */
	devFail = $state<{ step: string; mode: "error" | "hang" } | null>(null);
	/** Cache: Monat "YYYY-MM" -> Eintraege */
	entriesByMonth = $state<Record<string, Entry[]>>({});
	/** Zaehlt bei jeder Aenderung an den Eintragsdateien hoch. */
	entriesVersion = $state(0);
	/**
	 * Offene Rueckfrage: ein rueckdatierter Start wuerde abgeschlossene Zeiten
	 * kuerzen oder entfernen. Ein Dialog zeigt den Plan und bestaetigt ihn.
	 */
	backdatePrompt = $state<{ activityId: string; start: number; plan: BackdatePlan } | null>(null);
	/**
	 * Offene Rueckfrage: ein Eintrag reicht ueber Mitternacht in einen Tag mit
	 * Ganztags-Abwesenheit. Bestaetigen entfernt die Abwesenheit(en) und legt
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
				};
				days: BlockedDay[];
		  }
		| { kind: "update"; originalStartTs: number; entry: Entry; days: BlockedDay[] }
		| null
	>(null);

	#tick: ReturnType<typeof setInterval> | null = null;

	/**
	 * Daten laden und die Uhr starten. Erneut aufrufbar (Knopf "Erneut versuchen").
	 *
	 * @returns true = bereit; false = gescheitert, Details stehen in `initError`.
	 */
	async init(): Promise<boolean> {
		if (!this.loaded) {
			this.initError = null;
			const begonnen = Date.now();
			try {
				// Erster Start? (settings.json noch nicht vorhanden – vor dem ersten Speichern pruefen)
				const firstRun = !(await this.#step("Einstellungen suchen", settingsFileExists));
				this.activities = await this.#step("Aktivitäten laden", loadActivities);
				this.settings = await this.#step("Einstellungen laden", loadSettings);
				// VOR jeder Datumsrechnung: currentMonth, prevMonthKey und
				// #findRunning haengen alle an der Zeitzone. Stuende sie erst danach,
				// laedt der Start an einer Tagesgrenze den falschen Monat.
				await this.#step("Zeitzone bestimmen", () => this.#applyTimeZone());
				// So frueh wie moeglich: bis hierher haelt analytics.ts alles zurueck,
				// was seit dem Start anfiel.
				setErrorReportsEnabled(this.settings.errorReportsEnabled);
				// Altlasten frueherer Versionen einmalig wegraeumen; darf den Start nie kippen.
				await this.#step("Datenordner aufräumen", async () => {
					try {
						await pruneEmptyMonthFiles();
					} catch (e) {
						logWarn("Aufräumen leerer Monatsdateien fehlgeschlagen", e);
					}
				});
				await this.#step("Aktivitäten prüfen", () => this.#seedBuiltins());
				const month = this.currentMonth;
				await this.#step(`Einträge ${month} laden`, () => this.ensureMonth(month));
				const prev = prevMonthKey();
				await this.#step(`Einträge ${prev} laden`, () => this.ensureMonth(prev));
				await this.#step("Laufenden Timer suchen", () => this.#findRunning());
				this.showOnboarding = firstRun;
				this.loaded = true;
				this.initStep = null;
				logInfo("Daten geladen", {
					ms: Date.now() - begonnen,
					erstStart: firstRun,
					aktivitaeten: this.activities.length,
					eintraege: this.monthEntries(month).length + this.monthEntries(prev).length,
					laeuft: this.#runningName()
				});
			} catch (e) {
				// Merken statt werfen: eine abgewiesene Promise landete nur in der
				// Konsole, und davor sitzt niemand – zu sehen war weiterhin "Laedt…".
				logError(`Start fehlgeschlagen beim Schritt „${this.initStep}"`, e);
				this.initError = { step: this.initStep ?? "Start", message: errorText(e) };
				return false;
			}
		}
		// IMMER (neu) starten, auch wenn die Daten schon geladen sind: der Cleanup der
		// Seite ruft dispose(), und ein frueher Ausstieg oben liess die Uhr danach fuer
		// immer stehen – kein Tick, keine Live-Dauer, kein Mitternachts-Wechsel.
		this.#startTick();
		return true;
	}

	/** Einen Startschritt benennen und ausfuehren; der Name steht im Ladebildschirm. */
	async #step<T>(label: string, fn: () => Promise<T>): Promise<T> {
		this.initStep = label;
		await this.#devInterrupt(label);
		return await fn();
	}

	/**
	 * Dev-Stoerung, siehe `devFail`. Wirkt genau einmal und VOR dem Schritt: der
	 * Schritt selbst laeuft dann gar nicht erst an, es wird also nichts gelesen,
	 * geschrieben oder geloescht.
	 */
	async #devInterrupt(label: string): Promise<void> {
		const fault = this.devFail;
		if (!fault || !label.includes(fault.step)) return;
		// Zuruecksetzen, bevor es knallt: der naechste Anlauf ("Erneut versuchen")
		// soll normal durchlaufen, sonst haenge man in der Schleife fest.
		this.devFail = null;
		if (fault.mode === "error") {
			throw new Error(`Test aus dem Dev-Menü: Schritt „${label}" abgebrochen`);
		}
		logWarn(`Dev-Test: Start bleibt absichtlich bei „${label}" stehen (${DEV_HANG_MS / 1000} s)`);
		// Von selbst weiter, statt fuer immer zu stehen – wer nur schauen wollte,
		// muss die App sonst neu laden.
		await new Promise((resolve) => setTimeout(resolve, DEV_HANG_MS));
	}

	#startTick(): void {
		// Erst den alten stoppen: sonst tickten nach einem Remount zwei gegeneinander,
		// mit zwei Mitternachts-Wechseln und doppelten Eintraegen als Folge.
		this.dispose();
		this.#tick = setInterval(() => {
			this.now = Date.now();
			void this.#rolloverAtMidnight();
		}, 1000);
	}

	/** Tick stoppen. Fuer den Cleanup der Seite. */
	dispose(): void {
		if (this.#tick !== null) {
			clearInterval(this.#tick);
			this.#tick = null;
		}
	}

	/**
	 * Liest Aktivitäten/Einstellungen/aktuelle Monate neu von Platte.
	 * Für das zweite Fenster (Tray-Flyout) und fensterübergreifende Updates,
	 * da jede Webview ihren eigenen Zustand hat.
	 */
	async reload(): Promise<void> {
		this.activities = await loadActivities();
		this.settings = await loadSettings();
		await this.#applyTimeZone();
		setErrorReportsEnabled(this.settings.errorReportsEnabled);
		for (const m of [this.currentMonth, prevMonthKey()]) {
			this.entriesByMonth[m] = await loadEntries(m);
		}
		this.running = null;
		await this.#findRunning();
		this.now = Date.now();
		this.loaded = true;
		// Ein anderes Fenster hat geschrieben – abgeleitete Listen neu lesen.
		this.entriesVersion++;
		logDebug("Daten neu geladen", { laeuft: this.#runningName() });
	}

	/** Name des laufenden Timers, fuers Protokoll. */
	#runningName(): string | null {
		return this.running ? this.activityName(this.running.activityId) : null;
	}

	get currentMonth(): string {
		return monthKey(this.now);
	}

	// ---------- Aktivitaeten ----------
	get visibleActivities(): Activity[] {
		return this.activities
			.filter((a) => !a.archived)
			.sort((a, b) => a.sortOrder - b.sortOrder);
	}

	get absenceActivity(): Activity | undefined {
		return this.activities.find((a) => a.isAbsence);
	}

	activityName(id: string): string {
		return this.activities.find((a) => a.id === id)?.name ?? "(gelöscht)";
	}

	async #seedBuiltins(): Promise<void> {
		let changed = false;
		const ensure = (name: string, isAbsence: boolean) => {
			if (!this.activities.some((a) => a.name === name)) {
				this.activities.push({
					id: uid(),
					name,
					sortOrder: this.activities.length,
					archived: false,
					isAbsence
				});
				changed = true;
			}
		};
		ensure(BUILTIN_OTHERS, false);
		ensure(BUILTIN_ABSENCE, true);
		if (changed) await this.persistActivities();
	}

	async persistActivities(): Promise<void> {
		await saveActivities($state.snapshot(this.activities) as Activity[]);
	}

	/** Mehrere Aktivitaetsnamen importieren (jede Zeile = eine). Bestehende bleiben. */
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
		// "Others"/"Abwesenheiten" immer ans Ende
		this.#reindexBuiltinsLast();
		if (added) await this.persistActivities();
		return added;
	}

	#reindexBuiltinsLast(): void {
		const builtins = this.activities.filter((a) => a.isAbsence || a.name === BUILTIN_OTHERS);
		const rest = this.activities.filter((a) => !(a.isAbsence || a.name === BUILTIN_OTHERS));
		[...rest, ...builtins].forEach((a, i) => (a.sortOrder = i));
	}

	/**
	 * Legt eine Aktivitaet an und liefert deren id. Existiert bereits eine (nicht
	 * archivierte) Aktivitaet mit gleichem Namen, wird deren id zurückgegeben statt
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
		if (!a || a.isAbsence || a.name === BUILTIN_OTHERS) return;
		a.name = name.trim() || a.name;
		await this.persistActivities();
	}

	/** Eingebaute Zeile? Die sind nicht umbenennbar/loeschbar. */
	isBuiltinActivity(a: Activity): boolean {
		return a.isAbsence || a.name === BUILTIN_OTHERS;
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
		if (a && !a.isAbsence && a.name !== BUILTIN_OTHERS) {
			a.hidden = !a.hidden;
			await this.persistActivities();
		}
	}

	async setArchived(id: string, archived: boolean): Promise<void> {
		const a = this.activities.find((x) => x.id === id);
		if (a && !a.isAbsence && a.name !== BUILTIN_OTHERS) {
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
		if (!a || a.isAbsence || a.name === BUILTIN_OTHERS) return 0;

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
		logWarn(`Aktivität gelöscht: ${name}`, { id, eintraege: removed });
		return removed;
	}

	/** Verschiebt `draggedId` vor/hinter `targetId` (Drag & Drop). */
	async reorderActivity(draggedId: string, targetId: string, placeAfter = false): Promise<void> {
		if (draggedId === targetId) return;
		const ordered = [...this.activities].sort((a, b) => a.sortOrder - b.sortOrder);
		const from = ordered.findIndex((a) => a.id === draggedId);
		if (from < 0) return;
		const [moved] = ordered.splice(from, 1);
		let to = ordered.findIndex((a) => a.id === targetId);
		if (to < 0) return;
		if (placeAfter) to += 1;
		ordered.splice(to, 0, moved);
		ordered.forEach((a, i) => (a.sortOrder = i));
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

	// ---------- Eintraege ----------
	/** Laufende Ladevorgaenge je Monat. */
	#loadingMonths = new Map<string, Promise<void>>();

	async ensureMonth(month: string): Promise<void> {
		if (this.entriesByMonth[month]) return;
		let pending = this.#loadingMonths.get(month);
		if (!pending) {
			pending = loadEntries(month)
				.then((entries) => {
					this.entriesByMonth[month] = entries;
				})
				.finally(() => {
					this.#loadingMonths.delete(month);
				});
			this.#loadingMonths.set(month, pending);
		}
		return pending;
	}

	monthEntries(month: string): Entry[] {
		return this.entriesByMonth[month] ?? [];
	}

	/** Ist dieser Monat bereits geladen? */
	monthLoaded(month: string): boolean {
		return this.entriesByMonth[month] !== undefined;
	}

	/**
	 * Alle Eintraege eines Jahres endgueltig loeschen.
	 * Der Cache muss mit: sonst zeigte die App Eintraege weiter an, die es auf der
	 * Platte nicht mehr gibt. Ein laufender Timer in dem Jahr wird vorher gestoppt.
	 */
	async deleteYearEntries(year: number): Promise<number> {
		const deleted = await deleteYear(year);
		logWarn(`Jahr ${year} gelöscht`, { monate: deleted });
		for (const m of deleted) delete this.entriesByMonth[m];
		if (this.running && monthKey(this.running.startTs).startsWith(`${year}-`)) {
			this.running = null;
		}
		this.entriesVersion++;
		return deleted.length;
	}

	async #saveMonth(month: string): Promise<void> {
		const list = this.entriesByMonth[month];
		// Kein Cache-Eintrag heisst "nicht geladen", nicht "leer". Frueher war das
		// egal, weil `[]` eine leere Datei schrieb – heute LOESCHT saveEntries sie.
		// Ohne diese Wache wuerde ein ungeladener Monat still geleert.
		if (!list) return;
		await saveEntries(month, $state.snapshot(list) as Entry[]);
		// Einziger Weg, auf dem Eintraege auf die Platte kommen – deshalb sitzt das
		// Signal hier und nicht bei den Aufrufern.
		this.entriesVersion++;
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
	 * Sammelt die Ganztags-Abwesenheiten, auf die die uebergebenen Tage treffen
	 * (dedupliziert nach Abwesenheits-Eintrag). Fuer die Folgetage einer
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
	 * Eintrag anlegen. Geht er ueber Mitternacht, entsteht je Tag einer – dieselbe
	 * Regel wie beim Timer: sonst zaehlte die Zeit nach 00:00 zum Vortag und an
	 * einer Monatsgrenze im falschen Bericht.
	 *
	 * @returns das erste Tagesstueck, oder null wenn nichts angelegt wurde
	 */
	async addEntry(
		activityId: string,
		startTs: number,
		endTs: number | null,
		note = "",
		source: EntrySource = "manual",
		dayFraction?: number,
		opts: { confirmAbsenceOverride?: boolean } = {}
	): Promise<Entry | null> {
		await this.ensureMonth(monthKey(startTs));
		if (endTs !== null) await this.ensureMonth(monthKey(endTs));

		// Regel: Ganztags-Abwesenheit und Projektzeit am selben Tag schließen sich aus.
		if (this.#reportConflict({ activityId, startTs, endTs, dayFraction })) return null;

		// Abwesenheiten sind tagesgenau (start == end == Tagesmitte), ein laufender
		// Timer hat noch kein Ende – beide koennen nicht ueber Mitternacht gehen.
		const parts =
			endTs === null || dayFraction != null
				? [{ startTs, endTs }]
				: splitAtMidnight(startTs, endTs);

		// #reportConflict prueft nur den ERSTEN Tag. Ein Folgetag aus der Teilung
		// kann trotzdem auf eine Ganztags-Abwesenheit treffen – ohne diese Wache
		// entstuende dort still Projektzeit (dieselbe Regel, die #addSegment fuer
		// den Timer-Pfad schon durchsetzt). Interaktive Aufrufer koennen per
		// opts.confirmAbsenceOverride stattdessen eine Rueckfrage anbieten, die
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
					args: { activityId, startTs, endTs, note, source, dayFraction },
					days: blocked
				};
				return null;
			}
		}

		let first: Entry | null = null;
		for (const p of parts) {
			const e = await this.#pushEntry(activityId, p.startTs, p.endTs, note, source, dayFraction);
			first ??= e;
		}
		return first;
	}

	/** Einen Eintrag ohne weitere Pruefung anlegen und speichern. */
	async #pushEntry(
		activityId: string,
		startTs: number,
		endTs: number | null,
		note: string,
		source: EntrySource,
		dayFraction?: number
	): Promise<Entry> {
		const month = monthKey(startTs);
		await this.ensureMonth(month);
		const entry: Entry = { id: uid(), activityId, startTs, endTs, note, source };
		if (dayFraction != null) entry.dayFraction = dayFraction;
		this.entriesByMonth[month].push(entry);
		await this.#saveMonth(month);
		return entry;
	}

	isAbsenceId(activityId: string): boolean {
		return !!this.activities.find((a) => a.id === activityId)?.isAbsence;
	}

	/**
	 * Aktivitaeten fuer die Timer-Auswahl: ohne Abwesenheiten und ohne ausgeblendete,
	 * Favoriten zuerst, dann nach Reihenfolge.
	 */
	get trackableActivities(): Activity[] {
		return this.visibleActivities
			.filter((a) => !a.isAbsence && !a.hidden)
			.sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.sortOrder - b.sortOrder);
	}

	/** Die zuletzt genutzten trackbaren Aktivitaeten (fuer Tray-Schnellstart). */
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

	/** Schnellstart-Liste: Favoriten zuerst, dann mit den zuletzt benutzten aufgefuellt. */
	quickActivities(limit: number): Activity[] {
		const seen = new Set<string>();
		const out: Activity[] = [];
		const favoriten = this.trackableActivities.filter((a) => a.favorite);
		for (const a of [...favoriten, ...this.recentActivities(limit)]) {
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
		/** true = Zeiten unveraendert, Ueberschneidung nicht neu pruefen */
		skipOverlap?: boolean;
	}): boolean {
		// Ein Kandidat kann ueber Mitternacht bis in einen anderen Monat reichen
		// (Monatsletzter -> Monatserster). dayConflict interessiert sich ohnehin
		// nur fuer den Tag von candidate.startTs, filtert also unpassende
		// endMonth-Eintraege selbst heraus – overlapConflict braucht die vollstaendige
		// Liste, sonst uebersaehe es eine Ueberschneidung am Monatsanfang.
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
				`Überschneidet sich mit „${this.activityName(overlap.activityId)}" (${von}–${bis}).`
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
		// Kann von newMonth abweichen, wenn die Bearbeitung ueber einen Monatswechsel
		// reicht – #reportConflict braucht diesen Monat fuer den Ueberschneidungs-Check.
		if (updated.endTs != null) await this.ensureMonth(monthKey(updated.endTs));
		// Die Ueberschneidungs-Regel ist neu; aeltere Daten koennen sie verletzen.
		// Wer nur die Notiz aendert, darf davon nicht ausgesperrt werden – sonst
		// bliebe fuer solche Eintraege nur noch Loeschen. Zeiten unveraendert ->
		// keine neue Ueberschneidung moeglich.
		const old = this.monthEntries(oldMonth).find((e) => e.id === updated.id);
		const timesUnchanged =
			!!old && old.startTs === updated.startTs && old.endTs === updated.endTs;
		if (this.#reportConflict({ ...updated, skipOverlap: timesUnchanged })) return false;

		// Ueber Mitternacht bearbeitet: der Eintrag behaelt den ersten Tag, die
		// weiteren Tage werden eigene Eintraege – wie beim Anlegen und beim Timer.
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

	// ---------- Timer ----------
	/** Alle aktuell offenen Einträge (endTs === null) über die geladenen Monate. */
	#openEntries(): Entry[] {
		const out: Entry[] = [];
		for (const list of Object.values(this.entriesByMonth)) {
			for (const e of list) if (e.endTs === null) out.push(e);
		}
		return out;
	}

	/** Die zusammenhaengenden Stuecke EINES Laufs, aeltestes zuerst. */
	runChain(entry: Entry): Entry[] {
		const all = Object.values(this.entriesByMonth).flat();
		const chain = [entry];
		const seen = new Set([entry.id]);
		for (;;) {
			const cur = chain[0];
			const passend = all.filter(
				(e) =>
					!seen.has(e.id) &&
					e.activityId === cur.activityId &&
					startOfNextDay(e.startTs) === cur.startTs
			);
			// Das exakt anschliessende Stueck gewinnt, ein offenes ist nur der
			// Rueckfall. Beides in EINE Suche zu werfen machte das Ergebnis von der
			// Reihenfolge in der Monatsdatei abhaengig: laege eine vergessene offene
			// Zeile vor dem echten Vorgaenger, gewaenne sie – und der Lauf saehe je
			// nach Dateireihenfolge anders aus.
			const prev =
				passend.find((e) => e.endTs === cur.startTs) ?? passend.find((e) => e.endTs === null);
			if (!prev) return chain;
			seen.add(prev.id);
			chain.unshift(prev);
		}
	}

	/** Beginn des laufenden Laufs – vor der Mitternachts-Teilung. Null = kein Timer. */
	get runStartTs(): number | null {
		return this.running ? this.runChain(this.running)[0].startTs : null;
	}

	/** Sekunden des laufenden LAUFS, ueber Mitternachts-Teilungen hinweg. */
	get runSeconds(): number {
		const start = this.runStartTs;
		return start === null ? 0 : Math.max(0, Math.floor((this.now - start) / 1000));
	}

	/** Schließt ALLE offenen Einträge (egal welches Fenster sie öffnete). running = null. */
	async #closeAllOpen(endTs = Date.now()): Promise<void> {
		const offen = this.#openEntries();
		if (offen.length > 0) {
			logInfo(`Timer gestoppt: ${offen.map((e) => this.activityName(e.activityId)).join(", ")}`, {
				ende: new Date(endTs).toISOString(),
				sekunden: offen.map((e) => Math.round((Math.max(e.startTs, endTs) - e.startTs) / 1000))
			});
		}
		// Der ganze Lauf, nicht nur das letzte Tagesstueck: eine Endzeit vor
		// Mitternacht muss die schon abgetrennten Stuecke mitnehmen.
		const chains = offen.map((open) => this.runChain(open)).sort((a, b) => b.length - a.length);
		const erledigt = new Set<string>();

		const months = new Set<string>();
		for (const chain of chains) {
			// Nie vor den Beginn des Laufs – sonst entstuende eine negative Dauer.
			const end = Math.max(chain[0].startTs, endTs);
			for (let i = 0; i < chain.length; i++) {
				const piece = chain[i];
				if (erledigt.has(piece.id)) continue;
				erledigt.add(piece.id);
				// Ein Stueck endet spaetestens dort, wo das naechste des Laufs beginnt.
				// Sonst zerlegte ein offen gebliebenes Vorgaengerstueck den Folgetag
				// noch einmal – neben dem Stueck, das ihn schon abdeckt.
				const bis = Math.min(end, chain[i + 1]?.startTs ?? end);
				const m = monthKey(piece.startTs);
				months.add(m);
				// Stuecke komplett nach dem Ende gab es nie. Das erste bleibt, damit
				// ein Lauf nicht spurlos verschwindet (dann eben mit Dauer 0).
				if (piece.id !== chain[0].id && piece.startTs >= end) {
					const list = this.entriesByMonth[m];
					const k = list?.findIndex((x) => x.id === piece.id) ?? -1;
					if (k >= 0) list.splice(k, 1);
					continue;
				}
				if (piece.endTs !== null && piece.endTs <= bis) continue;
				// Ueber Mitternacht in Tagesstuecke zerlegen: sonst zaehlte die Zeit
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
	}

	/**
	 * Folgetag-Stueck eines geteilten Eintrags anlegen; liefert dessen Monat –
	 * oder null, wenn der Tag eine Ganztags-Abwesenheit traegt.
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
	 * Laeuft der Timer ueber Mitternacht, wird er dort beendet und am neuen Tag
	 * fortgesetzt. Laeuft jede Sekunde mit – der Datumsvergleich haelt das billig.
	 */
	async #rolloverAtMidnight(): Promise<void> {
		if (!this.running || fmtDate(this.running.startTs) === fmtDate(Date.now())) return;
		await this.#exclusive(async () => {
			// Nach dem Anstehen erneut pruefen: der Tick feuert im Sekundentakt.
			const cur = this.running;
			if (!cur || fmtDate(cur.startTs) === fmtDate(Date.now())) return;
			const parts = splitAtMidnight(cur.startTs, Date.now());
			if (parts.length < 2) return;

			const months = new Set<string>([monthKey(cur.startTs)]);
			cur.endTs = parts[0].endTs;
			// Zwischentage entstehen, wenn die App durchlief; das letzte Stueck laeuft weiter.
			for (const p of parts.slice(1, -1)) {
				const seg = await this.#addSegment(cur, p.startTs, p.endTs);
				if (seg) months.add(seg);
			}

			const last = parts[parts.length - 1];
			const m = monthKey(last.startTs);
			await this.ensureMonth(m);
			// Idempotent: gibt es fuer diese Aktivitaet schon einen offenen Eintrag
			// exakt ab dieser Mitternacht, lief der Wechsel bereits. Sonst entstuende
			// ein zweiter – zwei offene Eintraege mit identischem Start, die spaeter
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
				tage: parts.length,
				weiterAb: new Date(last.startTs).toISOString()
			});
		});
	}

	/**
	 * Den laufenden Eintrag bestimmen: der neueste offene. Aeltere offene bleiben
	 * zurueck, wenn die App abgestuerzt ist oder ein Start den vorherigen nicht
	 * sauber beendet hat – die muessen geschlossen werden, sonst laufen sie ewig.
	 */
	async #findRunning(): Promise<void> {
		const open = this.#openEntries().sort((a, b) => b.startTs - a.startTs);
		this.running = open[0] ?? null;
		if (open.length <= 1) return;

		const months = new Set<string>();
		let geschaetzt = 0;
		// open[i-1] ist der naechstjuengere: dessen Start beendete open[i].
		for (let i = 1; i < open.length; i++) {
			const e = open[i];
			const end = Math.min(open[i - 1].startTs, startOfNextDay(e.startTs));
			e.endTs = Math.max(e.startTs, end);
			if (e.endTs > e.startTs) geschaetzt++;
			months.add(monthKey(e.startTs));
		}
		for (const m of months) await this.#saveMonth(m);

		// Melden statt still korrigieren: die Zeiten sind geraten, nur der Benutzer
		// weiss, ob sie stimmen.
		if (geschaetzt > 0) {
			logWarn(`${geschaetzt} offene Einträge geschätzt geschlossen`, {
				eintraege: open.slice(1).map((e) => ({
					aktivitaet: this.activityName(e.activityId),
					von: new Date(e.startTs).toISOString(),
					bis: e.endTs ? new Date(e.endTs).toISOString() : null
				}))
			});
			toast.warning(
				geschaetzt === 1
					? "Ein Eintrag lief noch – das Ende wurde geschätzt. Bitte prüfen."
					: `${geschaetzt} Einträge liefen noch – die Enden wurden geschätzt. Bitte prüfen.`
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

		// Laden VOR dem Pruefen: monthEntries liefert fuer einen ungeladenen Monat
		// [], jede Wache ginge sonst still durch. Ein ueber den Monatswechsel
		// offenes Fenster hat den aktuellen Monat nicht zwingend geladen.
		await this.#ensureSpan(start);

		if (this.hasFullDayAbsence(start)) {
			// Den Tag benennen: bei rueckdatiertem Start kann das der VORTAG sein
			// (kurz nach Mitternacht "vor 60 Min"). "An diesem Tag" liess einen dann
			// auf heute schauen, wo gar keine Abwesenheit steht.
			toast.error(
				`Am ${fmtDateHuman(start)} ist eine Ganztags-Abwesenheit eingetragen – dort kann kein Timer beginnen.`
			);
			return;
		}

		// Abgeschlossene Zeiten anzufassen ist eine Ansage – dafuer wird gefragt.
		// Einen laufenden Timer zu kuerzen ist der normale Wechsel, das laeuft still.
		if (planNeedsConfirm(this.#planFor(start))) {
			this.backdatePrompt = { activityId, start, plan: this.#planFor(start) };
			return;
		}
		await this.#applyStart(activityId, start);
	}

	/** Beide Enden von [start, jetzt] laden – bei Rueckdatierung ueber einen
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

		// Wechsel ohne Flackern: alte Eintraege anpassen UND neuen setzen in EINEM
		// synchronen Schritt (kein await dazwischen -> running wird nie kurz null).
		const months = new Set<string>();
		// Tagesstuecke der Kuerzung erst nach dem synchronen Block anlegen (#addSegment
		// ist async). Ein offener Eintrag von vorgestern, der jetzt gekuerzt wird, ergaebe
		// sonst EINEN Eintrag ueber mehrere Tage – im Bericht eine 50-Stunden-Zeile.
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
		logInfo(`Timer gestartet: ${this.activityName(activityId)}`, {
			start: new Date(start).toISOString(),
			rueckdatiert: Date.now() - start > 60_000 ? Math.round((Date.now() - start) / 60_000) : 0,
			gekuerzt: plan.truncate.length,
			entfernt: plan.remove.length
		});
	}

	/** Rueckfrage bestaetigen: Plan neu bilden und starten. */
	async confirmBackdate(): Promise<void> {
		const p = this.backdatePrompt;
		if (!p) return;
		this.backdatePrompt = null;
		await this.#exclusive(() => this.#applyStart(p.activityId, p.start));
	}

	/**
	 * Rueckfrage bestaetigen: die blockierenden Ganztags-Abwesenheiten entfernen
	 * und den urspruenglichen Aufruf danach unveraendert wiederholen – die
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
				{ confirmAbsenceOverride: true }
			);
		} else {
			await this.updateEntry(p.originalStartTs, p.entry);
		}
	}

	/** Startet einen Timer, optional rückdatiert (startTs in der Vergangenheit). */
	startActivity(activityId: string, startTs?: number): Promise<void> {
		return this.#exclusive(() => this.#startInternal(activityId, startTs));
	}

	/** Startet/stoppt den zuletzt benutzten Timer (fuer globalen Hotkey). */
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
	 * Legt Abwesenheits-Eintraege fuer einen Datumsbereich an (inkl. beider Tage),
	 * optional ohne Wochenenden. Gibt die Anzahl angelegter Tage zurueck.
	 */
	async addAbsenceRange(
		startDate: string,
		endDate: string,
		fraction = 1
	): Promise<{ added: number; skipped: number }> {
		const abs = this.absenceActivity;
		if (!abs) return { added: 0, skipped: 0 };
		if (Number.isNaN(noonTs(startDate)) || Number.isNaN(noonTs(endDate)) || endDate < startDate) {
			return { added: 0, skipped: 0 };
		}
		let added = 0;
		let skipped = 0;
		// Ueber Kalendertage statt ueber einen Date-Cursor: der haengt an der Zone
		// des Geraets, und an einer Sommerzeit-Grenze trifft +24 h den falschen Tag.
		for (let date = startDate; date <= endDate; date = stepDate(date, 1)) {
			// Nur reguläre Arbeitstage; Wochenenden/freie Tage nicht als Abwesenheit buchen.
			if (!this.settings.workdays.includes(weekdayOfDate(date))) continue;
			const noon = noonTs(date);
			// Ganztags-Konflikt mit Projektzeit -> Tag still überspringen (kein Doppel-Toast).
			if (fraction >= 1 && this.hasProjectEntry(noon)) {
				skipped++;
				continue;
			}
			const e = await this.addEntry(abs.id, noon, noon, "", "manual", fraction);
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

	/** Markiert einen Monat als erledigt (gesendet oder „nicht mehr erinnern"). */
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
		if (stored) logWarn(`Unbekannte Zeitzone „${stored}", nutze ${fallback}`);
		this.settings = { ...this.settings, timeZone: fallback };
		await saveSettings($state.snapshot(this.settings) as Settings);
		logInfo("Zeitzone festgeschrieben", { zone: fallback });
	}

	async updateSettings(patch: Partial<Settings>): Promise<void> {
		this.settings = { ...this.settings, ...patch };
		// Sofort wirksam machen: alles Weitere in diesem Durchlauf rechnet sonst
		// noch gegen die alte Zone.
		if (patch.timeZone !== undefined) setAppTimeZone(patch.timeZone);
		// Vor dem Speichern: ein Abschalten soll sofort greifen, nicht erst, wenn
		// das Schreiben durch ist.
		if (patch.errorReportsEnabled !== undefined) setErrorReportsEnabled(patch.errorReportsEnabled);
		await saveSettings($state.snapshot(this.settings) as Settings);
		// Mit Werten: „E-Mail war leer" ist die Art Frage, die hinterher niemand
		// mehr beantworten kann. Die Einstellungen sind harmlos – kein Passwort,
		// keine Zeiten, nur die Konfiguration, die der Benutzer selbst sieht.
		logDebug("Einstellungen gespeichert", patch);
	}

	// ---------- Onboarding ----------
	/**
	 * Willkommensbildschirm abschliessen: uebernimmt die eingegebenen Werte und
	 * schreibt settings.json (dadurch gilt der naechste Start nicht mehr als erster).
	 * Auch beim "Ueberspringen" (ggf. mit leerem patch) aufrufen.
	 */
	async finishOnboarding(patch: Partial<Settings>): Promise<void> {
		await this.updateSettings(patch);
		this.showOnboarding = false;
	}

	/** Den Willkommensbildschirm weglegen, OHNE etwas zu schreiben. */
	dismissOnboarding(): void {
		this.showOnboarding = false;
	}

	/** Willkommensbildschirm erneut oeffnen (Dev-Re-Trigger). */
	openOnboarding(): void {
		this.showOnboarding = true;
	}

	/**
	 * Dev: den Ladebildschirm vorfuehren – Start wiederholen und dabei am Schritt
	 * `step` scheitern ("error") oder haengen bleiben ("hang").
	 */
	async devSimulateStartFault(mode: "error" | "hang", step = "Einträge"): Promise<void> {
		logInfo(`Dev-Test: Ladebildschirm (${mode}) bei Schritt „${step}"`);
		this.devFail = { step, mode };
		this.initError = null;
		this.initStep = null;
		this.loaded = false;
		await this.init();
	}
}

export const app = new AppState();
