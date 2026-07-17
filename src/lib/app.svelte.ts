// Zentraler, reaktiver App-Zustand (Svelte 5 Runes).
import { toast } from "svelte-sonner";
import type { Activity, Entry, EntrySource, Settings } from "./types";
import { BUILTIN_ABSENCE, BUILTIN_OTHERS, defaultSettings } from "./types";
import { fmtClock, fmtDate, fmtDateHuman, noonTs, splitAtMidnight, startOfNextDay } from "./time";
import { dayConflict, overlapConflict } from "./conflicts";
import { planBackdate, planNeedsConfirm, type BackdatePlan } from "./backdate";
import {
	deleteYear,
	listEntryMonths,
	loadActivities,
	loadEntries,
	loadSettings,
	monthKey,
	pruneEmptyMonthFiles,
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
	/**
	 * Offene Rueckfrage: ein rueckdatierter Start wuerde abgeschlossene Zeiten
	 * kuerzen oder entfernen. Ein Dialog zeigt den Plan und bestaetigt ihn.
	 */
	backdatePrompt = $state<{ activityId: string; start: number; plan: BackdatePlan } | null>(null);

	#tick: ReturnType<typeof setInterval> | null = null;

	async init(): Promise<void> {
		if (this.loaded) return;
		// Erster Start? (settings.json noch nicht vorhanden – vor dem ersten Speichern pruefen)
		const firstRun = !(await settingsFileExists());
		this.activities = await loadActivities();
		this.settings = await loadSettings();
		// Altlasten frueherer Versionen einmalig wegraeumen; darf den Start nie kippen.
		try {
			await pruneEmptyMonthFiles();
		} catch (e) {
			console.error("Aufraeumen leerer Monatsdateien fehlgeschlagen", e);
		}
		await this.#seedBuiltins();
		await this.ensureMonth(this.currentMonth);
		await this.ensureMonth(prevMonthKey());
		this.#findRunning();
		this.showOnboarding = firstRun;
		this.loaded = true;
		this.#tick = setInterval(() => {
			this.now = Date.now();
			void this.#rolloverAtMidnight();
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
		this.activities = this.activities.filter((x) => x.id !== id);
		await this.persistActivities();
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
	async ensureMonth(month: string): Promise<void> {
		if (!this.entriesByMonth[month]) {
			this.entriesByMonth[month] = await loadEntries(month);
		}
	}

	monthEntries(month: string): Entry[] {
		return this.entriesByMonth[month] ?? [];
	}

	/**
	 * Alle Eintraege eines Jahres endgueltig loeschen.
	 * Der Cache muss mit: sonst zeigte die App Eintraege weiter an, die es auf der
	 * Platte nicht mehr gibt. Ein laufender Timer in dem Jahr wird vorher gestoppt.
	 */
	async deleteYearEntries(year: number): Promise<number> {
		const deleted = await deleteYear(year);
		for (const m of deleted) delete this.entriesByMonth[m];
		if (this.running && monthKey(this.running.startTs).startsWith(`${year}-`)) {
			this.running = null;
		}
		return deleted.length;
	}

	async #saveMonth(month: string): Promise<void> {
		const list = this.entriesByMonth[month];
		// Kein Cache-Eintrag heisst "nicht geladen", nicht "leer". Frueher war das
		// egal, weil `[]` eine leere Datei schrieb – heute LOESCHT saveEntries sie.
		// Ohne diese Wache wuerde ein ungeladener Monat still geleert.
		if (!list) return;
		await saveEntries(month, $state.snapshot(list) as Entry[]);
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

	/**
	 * Eintrag anlegen. Geht er ueber Mitternacht, entsteht je Tag einer – dieselbe
	 * Regel wie beim Timer: sonst zaehlte die Zeit nach 00:00 zum Vortag und an
	 * einer Monatsgrenze im falschen Bericht.
	 *
	 * Der Konflikt-Check laeuft ueber die GANZE Spanne, bevor geteilt wird.
	 *
	 * @returns das erste Tagesstueck, oder null wenn nichts angelegt wurde
	 */
	async addEntry(
		activityId: string,
		startTs: number,
		endTs: number | null,
		note = "",
		source: EntrySource = "manual",
		dayFraction?: number
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
		const monthEntries = this.monthEntries(monthKey(candidate.startTs));
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

	/** Schließt ALLE offenen Einträge (egal welches Fenster sie öffnete). running = null. */
	async #closeAllOpen(endTs = Date.now()): Promise<void> {
		const months = new Set<string>();
		// Kopie je Liste: die Tagesstuecke unten haengen waehrend des Laufs an.
		for (const [m, list] of Object.entries(this.entriesByMonth)) {
			for (const e of [...list]) {
				if (e.endTs !== null) continue;
				const end = Math.max(e.startTs, endTs);
				// Ueber Mitternacht in Tagesstuecke zerlegen: sonst zaehlte die Zeit
				// nach 00:00 zum Vortag – an einer Monatsgrenze sogar in der falschen
				// Monatsdatei und damit im falschen Bericht.
				const parts = splitAtMidnight(e.startTs, end);
				e.endTs = parts[0].endTs;
				months.add(m);
				for (const p of parts.slice(1)) {
					const seg = await this.#addSegment(e, p.startTs, p.endTs);
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
	 *
	 * Ohne diese Wache umginge die Teilung die Regel, die #reportConflict ueberall
	 * sonst durchsetzt: an einem Ganztags-Abwesenheitstag gibt es keine Projektzeit.
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
		});
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

	/**
	 * Plan anwenden und den Timer setzen.
	 *
	 * Der Plan wird HIER neu gebildet, nicht von der Rueckfrage mitgebracht:
	 * dazwischen liegt eine Luecke ohne Sperre. Ein anderes Fenster kann per
	 * `data-reload` ein `reload()` ausloesen, das die Eintrags-Objekte komplett
	 * ersetzt – ein mitgebrachter Plan schriebe dann in abgehaengte Objekte, und
	 * die Kuerzung ginge lautlos verloren. Ausserdem koennen in der Luecke neue
	 * offene Eintraege entstehen (Mitternachts-Wechsel, Tray), die ein alter Plan
	 * nicht kennt – es gaebe zwei laufende Timer.
	 */
	async #applyStart(activityId: string, start: number): Promise<void> {
		await this.#ensureSpan(start);
		const plan = this.#planFor(start);
		const month = monthKey(start);

		// Wechsel ohne Flackern: alte Eintraege anpassen UND neuen setzen in EINEM
		// synchronen Schritt (kein await dazwischen -> running wird nie kurz null).
		const months = new Set<string>();
		for (const { entry, endTs } of plan.truncate) {
			entry.endTs = endTs;
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

		// Persistieren erst danach (beeinflusst die UI nicht mehr).
		for (const m of months) await this.#saveMonth(m);
	}

	/** Rueckfrage bestaetigen: Plan neu bilden und starten. */
	async confirmBackdate(): Promise<void> {
		const p = this.backdatePrompt;
		if (!p) return;
		this.backdatePrompt = null;
		await this.#exclusive(() => this.#applyStart(p.activityId, p.start));
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
		const start = new Date(noonTs(startDate));
		const end = new Date(noonTs(endDate));
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
