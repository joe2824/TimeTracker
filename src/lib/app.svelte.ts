// Zentraler, reaktiver App-Zustand (Svelte 5 Runes).
import { toast } from "svelte-sonner";
import type { Activity, Entry, EntrySource, Settings } from "./types";
import { BUILTIN_ABSENCE, BUILTIN_OTHERS, defaultSettings } from "./types";
import { fmtDate } from "./time";
import { dayConflict } from "./conflicts";
import {
	cleanupOldMonths,
	loadActivities,
	loadEntries,
	loadSettings,
	monthKey,
	saveActivities,
	saveEntries,
	saveSettings,
	settingsFileExists
} from "./store";

function uid(): string {
	return crypto.randomUUID();
}

function prevMonthKey(): string {
	const d = new Date();
	d.setMonth(d.getMonth() - 1);
	return monthKey(d.getTime());
}

class AppState {
	activities = $state<Activity[]>([]);
	settings = $state<Settings>({ ...defaultSettings });
	/** laufender Eintrag (endTs === null) oder null */
	running = $state<Entry | null>(null);
	/** tickt jede Sekunde fuer Live-Dauer */
	now = $state(Date.now());
	loaded = $state(false);
	/** true = Willkommensbildschirm anzeigen (erster Start oder Dev-Re-Trigger) */
	showOnboarding = $state(false);
	/** Cache: Monat "YYYY-MM" -> Eintraege */
	entriesByMonth = $state<Record<string, Entry[]>>({});

	#tick: ReturnType<typeof setInterval> | null = null;

	async init(): Promise<void> {
		if (this.loaded) return;
		// Erster Start? (settings.json noch nicht vorhanden – vor dem ersten Speichern pruefen)
		const firstRun = !(await settingsFileExists());
		this.activities = await loadActivities();
		this.settings = await loadSettings();
		if (this.settings.autoCleanup) {
			try {
				await cleanupOldMonths(12);
			} catch (e) {
				console.error("Cleanup fehlgeschlagen", e);
			}
		}
		await this.#seedBuiltins();
		await this.ensureMonth(this.currentMonth);
		await this.ensureMonth(prevMonthKey());
		this.#findRunning();
		this.showOnboarding = firstRun;
		this.loaded = true;
		this.#tick = setInterval(() => {
			this.now = Date.now();
		}, 1000);
	}

	/**
	 * Liest Aktivitäten/Einstellungen/aktuelle Monate neu von Platte.
	 * Für das zweite Fenster (Tray-Flyout) und fensterübergreifende Updates,
	 * da jede Webview ihren eigenen Zustand hat.
	 */
	async reload(): Promise<void> {
		this.activities = await loadActivities();
		this.settings = await loadSettings();
		for (const m of [this.currentMonth, prevMonthKey()]) {
			this.entriesByMonth[m] = await loadEntries(m);
		}
		this.running = null;
		this.#findRunning();
		this.now = Date.now();
		this.loaded = true;
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

	async renameActivity(id: string, name: string): Promise<void> {
		const a = this.activities.find((x) => x.id === id);
		if (a) {
			a.name = name.trim() || a.name;
			await this.persistActivities();
		}
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
	async ensureMonth(month: string): Promise<void> {
		if (!this.entriesByMonth[month]) {
			this.entriesByMonth[month] = await loadEntries(month);
		}
	}

	monthEntries(month: string): Entry[] {
		return this.entriesByMonth[month] ?? [];
	}

	async #saveMonth(month: string): Promise<void> {
		await saveEntries(month, $state.snapshot(this.entriesByMonth[month] ?? []) as Entry[]);
	}

	/** Ganztags-Abwesenheit an diesem Tag vorhanden? (Tagesanteil >= 1) */
	hasFullDayAbsence(ts: number): boolean {
		const absId = this.absenceActivity?.id;
		if (!absId) return false;
		const key = fmtDate(ts);
		return this.monthEntries(monthKey(ts)).some(
			(e) => e.activityId === absId && (e.dayFraction ?? 1) >= 1 && fmtDate(e.startTs) === key
		);
	}

	/** Projekt-(Nicht-Abwesenheits-)Eintrag an diesem Tag vorhanden? */
	hasProjectEntry(ts: number): boolean {
		const key = fmtDate(ts);
		return this.monthEntries(monthKey(ts)).some(
			(e) => !this.isAbsenceId(e.activityId) && fmtDate(e.startTs) === key
		);
	}

	async addEntry(
		activityId: string,
		startTs: number,
		endTs: number | null,
		note = "",
		source: EntrySource = "manual",
		dayFraction?: number
	): Promise<Entry | null> {
		const month = monthKey(startTs);
		await this.ensureMonth(month);

		// Regel: Ganztags-Abwesenheit und Projektzeit am selben Tag schließen sich aus.
		if (this.#reportConflict({ activityId, startTs, dayFraction })) return null;

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

	/**
	 * Prüft die Tagesregel (Ganztags-Abwesenheit ⊥ Projektzeit) für einen Eintrag,
	 * ohne den Eintrag selbst (`excludeId`) mitzuzählen. true = Konflikt.
	 */
	#reportConflict(candidate: {
		activityId: string;
		startTs: number;
		dayFraction?: number;
		id?: string;
	}): boolean {
		const conflict = dayConflict(
			this.monthEntries(monthKey(candidate.startTs)),
			candidate,
			this.absenceActivity?.id,
			{ excludeId: candidate.id }
		);
		if (conflict === "full-day-absence") {
			toast.error("An diesem Tag ist eine Ganztags-Abwesenheit eingetragen.");
			return true;
		}
		if (conflict === "project-time") {
			toast.error("An diesem Tag gibt es Projektzeiten – nur halber Urlaubstag möglich.");
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
		if (this.#reportConflict({ ...updated })) return false;
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

	/** Schließt ALLE offenen Einträge (egal welches Fenster sie öffnete). running = null. */
	async #closeAllOpen(endTs = Date.now()): Promise<void> {
		const months = new Set<string>();
		for (const [m, list] of Object.entries(this.entriesByMonth)) {
			for (const e of list) {
				if (e.endTs === null) {
					e.endTs = Math.max(e.startTs, endTs);
					months.add(m);
				}
			}
		}
		this.running = null;
		for (const m of months) await this.#saveMonth(m);
	}

	#findRunning(): void {
		// Neueste offene Aktivität ist die laufende; etwaige ältere Duplikate schließen.
		const open = this.#openEntries().sort((a, b) => b.startTs - a.startTs);
		this.running = open[0] ?? null;
		if (open.length > 1) {
			const months = new Set<string>();
			for (const e of open.slice(1)) {
				e.endTs = e.startTs; // Duplikat ohne Dauer schließen
				months.add(monthKey(e.startTs));
			}
			void Promise.all([...months].map((m) => this.#saveMonth(m)));
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
		// Rückdatierter Start: nie in der Zukunft, nie länger als 24 h zurück.
		const start = Math.min(startTs ?? now, now);
		if (this.hasFullDayAbsence(start)) {
			toast.error("An diesem Tag ist eine Ganztags-Abwesenheit eingetragen – kein Timer möglich.");
			return;
		}
		const month = monthKey(start);
		await this.ensureMonth(month);

		// Wechsel ohne Flackern: alten Timer schließen UND neuen setzen in EINEM
		// synchronen Schritt (kein await dazwischen -> running wird nie kurz null).
		const months = new Set<string>();
		for (const [m, list] of Object.entries(this.entriesByMonth)) {
			for (const e of list) {
				if (e.endTs === null) {
					e.endTs = Math.max(e.startTs, start);
					months.add(m);
				}
			}
		}
		const entry: Entry = { id: uid(), activityId, startTs: start, endTs: null, note: "", source: "timer" };
		this.entriesByMonth[month].push(entry);
		this.running = entry;
		months.add(month);

		// Persistieren erst danach (beeinflusst die UI nicht mehr).
		for (const m of months) await this.#saveMonth(m);
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
		const start = new Date(startDate + "T12:00:00");
		const end = new Date(endDate + "T12:00:00");
		if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) {
			return { added: 0, skipped: 0 };
		}
		let added = 0;
		let skipped = 0;
		for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
			// Nur reguläre Arbeitstage; Wochenenden/freie Tage nicht als Abwesenheit buchen.
			if (!this.settings.workdays.includes(d.getDay())) continue;
			// Ganztags-Konflikt mit Projektzeit -> Tag still überspringen (kein Doppel-Toast).
			if (fraction >= 1 && this.hasProjectEntry(d.getTime())) {
				skipped++;
				continue;
			}
			const e = await this.addEntry(abs.id, d.getTime(), d.getTime(), "", "manual", fraction);
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
	async updateSettings(patch: Partial<Settings>): Promise<void> {
		this.settings = { ...this.settings, ...patch };
		await saveSettings($state.snapshot(this.settings) as Settings);
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

	/** Willkommensbildschirm erneut oeffnen (Dev-Re-Trigger). */
	openOnboarding(): void {
		this.showOnboarding = true;
	}
}

export const app = new AppState();
