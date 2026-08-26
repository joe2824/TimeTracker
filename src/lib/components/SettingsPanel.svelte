<script lang="ts">
	import { onMount } from "svelte";
	import { app } from "$lib/app.svelte";
	import { listEntryYears, type StoredYear } from "$lib/store";
	import { scheduleReminders, scheduleReportReminder, ensureNotificationPermission } from "$lib/reminders";
	import {
		devTriggerIdle,
		devTriggerLongTimer,
		devTriggerReportReminder
	} from "$lib/watchers.svelte";
	import { formFromSettings, patchFrom, syncForm } from "$lib/settingsSync";
	import type { Settings } from "$lib/types";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import WorkdayPicker from "$lib/components/WorkdayPicker.svelte";
	import { Label } from "$lib/components/ui/label";
	import SettingToggle from "$lib/components/SettingToggle.svelte";
	import * as Select from "$lib/components/ui/select";
	import * as Card from "$lib/components/ui/card";
	import { toast } from "svelte-sonner";
	import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
	import { checkForUpdate, updater } from "$lib/updater.svelte";
	import { getVersion } from "@tauri-apps/api/app";
	import { invoke } from "@tauri-apps/api/core";
	import { relaunch } from "@tauri-apps/plugin-process";
	import { errorText, flushLog, logInfo } from "$lib/log";
	import { openExternal } from "$lib/platform/open";
	import * as Dialog from "$lib/components/ui/dialog";
	import { acceleratorFromEvent, applyShortcuts } from "$lib/shortcuts";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";
	import PlusIcon from "@lucide/svelte/icons/plus";
	import XIcon from "@lucide/svelte/icons/x";
	import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
	import WrenchIcon from "@lucide/svelte/icons/wrench";
	import ShortcutKey from "$lib/components/ShortcutKey.svelte";
	import SavedHint from "$lib/components/SavedHint.svelte";
	import SettingRow from "$lib/components/SettingRow.svelte";
	import AccountPanel from "$lib/components/AccountPanel.svelte";
	import AdminPanel from "$lib/components/AdminPanel.svelte";
	import LogPanel from "$lib/components/LogPanel.svelte";

	const REPO_URL = "https://github.com/joe2824/TimeTracker";

	/** Rundungsstufen des Berichts: Wert (Stunden) -> Beschriftung. */
	const ROUNDINGS: Record<string, string> = {
		"0.25": "Viertelstunde (0:15)",
		"0.5": "Halbe Stunde (0:30)",
		"1": "Volle Stunde (1:00)"
	};
	let appVersion = $state("");

	// Versteckter Dev-Modus: 10× schnell (≤3 s) aufs Logo tippen.
	// Der Schalter selbst liegt im App-Zustand, damit er das Vorfuehren des
	// Ladebildschirms ueberlebt – dabei wird diese Seite kurz abgebaut.
	let logoTaps: number[] = [];
	function tapLogo() {
		const now = Date.now();
		logoTaps = logoTaps.filter((t) => now - t < 3000);
		logoTaps.push(now);
		if (!app.devMode && logoTaps.length >= 10) {
			app.devMode = true;
			logoTaps = [];
			toast.success("Dev-Modus aktiviert");
		}
	}

	/** Dev: Flyout ueber denselben Weg oeffnen wie ein Klick aufs Tray-Icon. */
	async function showFlyout() {
		try {
			await invoke("show_flyout");
		} catch (e) {
			toast.error(`Flyout-Fehler: ${errorText(e)}`, { duration: 60000 });
		}
	}

	/**
	 * Arbeitskopie aller Einstellungen dieser Seite.
	 *
	 * Bearbeitet wird hier, gespeichert wird je Karte beim Verlassen des Feldes.
	 * Zahlen und Stunden stehen als Text darin – umgerechnet wird erst beim
	 * Speichern (settingsSync.ts), damit ein zum Neutippen geleertes Feld nicht
	 * still als 0 gespeichert wird.
	 */
	let form = $state(formFromSettings(current()));
	let recordingToggle = $state(false);

	/** Der gespeicherte Stand als schlichte Kopie (ohne Svelte-Proxy). */
	function current(): Settings {
		return $state.snapshot(app.settings) as Settings;
	}

	/**
	 * Zuletzt uebernommener Stand der Einstellungen.
	 *
	 * Bewusst KEIN $state: der Vergleich unten soll den Effekt nicht selbst wieder
	 * ausloesen. Und eine Momentaufnahme statt der Referenz, sonst zeigte er beim
	 * naechsten Lauf ohnehin schon die neuen Werte und faende nie einen Unterschied.
	 */
	let synced = current();

	/**
	 * Die Felder oben sind Kopien vom Aufbau dieser Seite. Aendert etwas anderes die
	 * Einstellungen – der Willkommens-Assistent, oder das Tray-Fenster ueber
	 * reload() –, zeigten sie sonst weiter die alten Werte und schrieben sie beim
	 * naechsten onchange zurueck.
	 *
	 * Der Assistent trifft das mit voller Wucht: bits-ui baut ALLE Tab-Inhalte
	 * sofort auf (inaktive nur `hidden`), diese Seite steht also schon mit leeren
	 * Feldern da, waehrend der Assistent noch offen ist. Die dort eingetragene
	 * Adresse der Vorgesetzten war damit beim ersten Klick in den Einstellungen
	 * wieder weg.
	 *
	 * Gleiches gilt fuer die Teamliste: der Team-Tab nimmt gefundene Absender per
	 * Klick auf: ohne diesen Abgleich stuende die neue Person zwar in der Datei,
	 * hier aber nicht in der Liste – und das naechste Speichern dieser Karte haette
	 * sie wieder entfernt.
	 */
	$effect(() => {
		synced = syncForm(form, synced, current());
	});

	async function saveTracking() {
		await save(TRACKING_KEYS);
		savedTracking = Date.now();
	}

	async function onToggleKey(e: KeyboardEvent) {
		if (!recordingToggle) return;
		e.preventDefault();
		if (e.key === "Escape") {
			recordingToggle = false;
			return;
		}
		if (e.key === "Backspace" || e.key === "Delete") {
			await app.updateSettings({ toggleShortcut: "" });
			recordingToggle = false;
			await applyShortcuts();
			return;
		}
		const acc = acceleratorFromEvent(e);
		if (!acc) return;
		await app.updateSettings({ toggleShortcut: acc });
		recordingToggle = false;
		await applyShortcuts();
	}

	async function clearToggle() {
		await app.updateSettings({ toggleShortcut: "" });
		await applyShortcuts();
	}

	onMount(async () => {
		try {
			form.autostart = await isEnabled();
		} catch (e) {
			toast.error(`Autostart-Status nicht lesbar: ${e}`, { duration: 60000 });
		}
		try {
			appVersion = await getVersion();
		} catch {
			/* nicht-desktop */
		}
	});

	// ---- Automatisches Speichern ----
	// Kein Speichern-Button: Autostart und Hotkey mussten ohnehin sofort wirken
	// (OS-API bzw. globale Registrierung), zwei gleich aussehende Schalter mit
	// zwei Verhalten waren der Bruch. Statt Toast je Aenderung ein kurzer Hinweis
	// an der Card – ein Toast pro Tastendruck waere Laerm.
	// Je Card ein eigener Zeitstempel UND eine eigene Speicherfunktion: eine
	// gemeinsame haette den Hinweis auch auf der Card blinken lassen, die man gar
	// nicht angefasst hat.
	let savedReport = $state(0);
	let savedWorktime = $state(0);
	let savedTimes = $state(0);
	let savedTracking = $state(0);
	let savedSystem = $state(0);
	let savedBoss = $state(0);

	// Welche Einstellungen zu welcher Card gehoeren. Die Umrechnung (getrimmt,
	// begrenzt, Uhrzeit -> Stunden) samt Rueckfall auf den gespeicherten Wert bei
	// geleertem Feld steckt in settingsSync.ts.
	const REPORT_KEYS = [
		"bossEmail",
		"senderName",
		"reportSubjectTemplate",
		"statsEnabled",
		"arbzgEnabled",
		"arbzgTrackingHint"
	] as const;
	const TIMES_KEYS = [
		"reminderTimes",
		"reportReminderEnabled",
		"reportReminderTime",
		"reportReminderLeadDays"
	] as const;
	const WORKTIME_KEYS = ["rounding", "hoursPerDay", "breakDeduction", "workdays"] as const;
	const TRACKING_KEYS = [
		"idleThresholdMin",
		"maxTimerHours",
		"pomodoroEnabled",
		"pomodoroMin",
		"pomodoroBreakMin",
		"shortcutNotify"
	] as const;
	const BOSS_KEYS = ["bossMode", "team", "teamSubjectFilter", "teamScanSubfolders"] as const;

	/** Die genannten Felder der Arbeitskopie speichern. */
	async function save(keys: readonly (keyof Settings)[]): Promise<void> {
		await app.updateSettings(patchFrom(form, keys, current()));
	}

	async function saveReport() {
		await save(REPORT_KEYS);
		savedReport = Date.now();
	}

	async function saveErrorReports() {
		await save(["errorReportsEnabled"]);
	}

	async function saveBossMode() {
		await save(BOSS_KEYS);
		savedBoss = Date.now();
	}

	async function saveWorktime() {
		await save(WORKTIME_KEYS);
		savedWorktime = Date.now();
	}

	/**
	 * Alle bekannten Zeitzonen, die aktuelle immer dabei.
	 *
	 * `supportedValuesOf` fehlt in aelteren Laufzeiten; dann bleibt wenigstens die
	 * gesetzte Zone waehlbar, statt dass die Liste leer ist und die Einstellung
	 * sich stillschweigend auf die erste beste umstellt.
	 */
	const timeZones = $derived.by(() => {
		let list: string[] = [];
		try {
			list = Intl.supportedValuesOf?.("timeZone") ?? [];
		} catch {
			list = [];
		}
		const current = app.settings.timeZone;
		return list.includes(current) || !current ? list : [current, ...list];
	});

	/**
	 * Die Zeitzone laeuft NICHT ueber das Formular-Zwischenmodell.
	 *
	 * Sie wirkt sofort auf jede Datumsrechnung der Oberflaeche – Monatsliste,
	 * Tagesgruppen, Auswertung. Ein Zwischenstand, der erst beim Speichern greift,
	 * zeigte dazwischen einen Bestand, den es so nicht gibt.
	 */
	async function saveTimeZone(tz: string) {
		if (!tz || tz === app.settings.timeZone) return;
		await app.updateSettings({ timeZone: tz });
		app.entriesVersion++; // abgeleitete Listen haengen an Tagesgrenzen
		savedWorktime = Date.now();
	}

	async function saveTimes() {
		await save(TIMES_KEYS);
		scheduleReminders();
		scheduleReportReminder();
		// Nur fragen, wenn ueberhaupt etwas benachrichtigen soll – beim Abschalten
		// nach der Erlaubnis zu fragen waere verkehrt herum.
		if (app.settings.reminderTimes.length > 0 || form.reportReminderEnabled) {
			await ensureNotificationPermission();
		}
		savedTimes = Date.now();
	}

	/**
	 * Umgeschalteter Update-Kanal, der noch nicht greift.
	 *
	 * Bleibt stehen, solange die Seite offen ist: der Neustart-Hinweis soll nicht
	 * verschwinden, weil jemand anderswo etwas gespeichert hat.
	 */
	let channelChanged = $state(false);

	async function saveBetaUpdates() {
		await save(["betaUpdates"]);
		savedSystem = Date.now();
		channelChanged = true;
		logInfo(`Update-Kanal umgestellt auf ${form.betaUpdates ? "Beta" : "stabil"}`);
	}

	/** Neu starten, damit der Rust-Teil die Endpunkte neu setzt. */
	async function restartApp() {
		try {
			await flushLog();
			await relaunch();
		} catch (e) {
			toast.error(`Neustart nicht möglich: ${errorText(e)}`, { duration: 60000 });
		}
	}

	async function toggleAutostart(v: boolean) {
		// form.autostart ist via bind:checked bereits gesetzt; bei Fehler zuruecksetzen.
		try {
			if (v) await enable();
			else await disable();
			await app.updateSettings({ autostart: v });
			savedSystem = Date.now();
		} catch (e) {
			form.autostart = !v;
			toast.error(`Autostart fehlgeschlagen: ${e}`, { duration: 60000 });
		}
	}

	// ---- Daten: ganze Jahre loeschen ----
	let years = $state<StoredYear[]>([]);
	let yearToDelete = $state<StoredYear | null>(null);
	let deleting = $state(false);

	// Neu lesen, sobald sich Eintraege geaendert haben – egal wo. Vorher lief das
	// nur beim Mount und nach dem Loeschen hier: neue Eintraege liessen das Jahr
	// erst nach einem Neuladen der Seite wieder auftauchen.
	$effect(() => {
		app.entriesVersion;
		void listEntryYears().then((y) => (years = y));
	});

	async function confirmDeleteYear() {
		const target = yearToDelete;
		if (!target) return;
		deleting = true;
		try {
			const months = await app.deleteYearEntries(target.year);
			toast.success(`${target.year} gelöscht (${months} Monatsdatei${months === 1 ? "" : "en"}).`);
			yearToDelete = null;
		} catch (e) {
			toast.error(`Löschen fehlgeschlagen: ${e}`);
		} finally {
			deleting = false;
		}
	}

	/**
	 * Die Bereiche der Einstellungen.
	 *
	 * Gruppiert nach dem, wonach jemand SUCHT, nicht danach, was technisch
	 * zusammengehoert: "Arbeitszeit" und "Zeiterfassung" waren zwei Karten, sind
	 * aber dieselbe Frage - wie lange arbeite ich und wie wird das gezaehlt.
	 */
	const BEREICHE = [
		{ id: "erfassung", titel: "Zeiterfassung" },
		{ id: "bericht", titel: "Bericht" },
		{ id: "erinnerungen", titel: "Erinnerungen" },
		{ id: "konto", titel: "Konto" },
		{ id: "system", titel: "System" },
		{ id: "ueber", titel: "Über" }
	] as const;

	type Bereich = (typeof BEREICHE)[number]["id"];

	let bereich = $state<Bereich>("erfassung");

	// Suche und Dialog liegen in $lib/updater.svelte – der Hinweis-Toast beim Start
	// öffnet denselben Dialog, ohne dass jemand hier vorbeikommen muss.
	function checkUpdate() {
		void checkForUpdate();
	}
</script>

<div class="space-y-4">
	<!--
		Ein Bereich zur Zeit.

		Frueher standen alle Karten untereinander. Das war uebersichtlich, solange es
		vier waren - bei elf sucht man. Die Bereiche schalten mit {#if} um und nicht
		ueber Tabs: Tabs montieren in dieser Bibliothek ALLE Inhalte gleichzeitig,
		und dann laufen unsichtbare Karten mit, deren Zustand still veraltet.

		Das Formular selbst bleibt oben in einem Stueck - es umfasst alle Bereiche,
		und ein Wechsel darf nichts verwerfen, was noch nicht gespeichert ist.
	-->
	<div class="flex flex-wrap gap-1 border-b pb-2">
		{#each BEREICHE as b (b.id)}
			<Button
				variant={bereich === b.id ? "secondary" : "ghost"}
				size="sm"
				onclick={() => (bereich = b.id)}
			>
				{b.titel}
			</Button>
		{/each}
	</div>

	<div class="grid gap-4 lg:grid-cols-2">
		{#if bereich === "erfassung"}
				<Card.Root>
					<Card.Header>
						<Card.Title>Zeiterfassung</Card.Title>
						<Card.Description>Verhalten von Timer, Hinweisen und Hotkey.</Card.Description>
						<Card.Action><SavedHint at={savedTracking} /></Card.Action>
					</Card.Header>
					<Card.Content class="space-y-4">
						<!-- Ein Rhythmus wie bei den Schaltern darunter: Titel links, Feld rechts.
						     Vorher ein 2er-Grid mit überlangen Labels („… (Min, 0 = aus)“) – die
						     Hinweise stehen jetzt in der Erklärungszeile, wo sie hingehören. -->
						<SettingRow
							id="idle"
							title="Leerlauf nachfragen ab"
							description="Nach so vielen Minuten ohne Eingabe nachfragen. 0 = aus."
						>
							{#snippet control()}
								<Input id="idle" type="number" min="0" class="w-24" bind:value={form.idleThresholdMin} onchange={saveTracking} />
							{/snippet}
						</SettingRow>

						<SettingRow
							id="maxh"
							title="Auto-Stop-Warnung ab"
							description="Warnen, wenn ein Timer länger als so viele Stunden läuft. 0 = aus."
						>
							{#snippet control()}
								<Input id="maxh" type="number" min="0" class="w-24" bind:value={form.maxTimerHours} onchange={saveTracking} />
							{/snippet}
						</SettingRow>

						<SettingToggle
							id="scnotify"
							title="Hinweis bei Shortcut-Start/Stop"
							description="Kurze Meldung, verschwindet selbst."
							bind:checked={form.shortcutNotify}
							onCheckedChange={() => saveTracking()}
						/>

						<SettingToggle
							id="pomo"
							title="Pomodoro"
							description="Fokus-/Pausen-Zyklus mit Hinweisen (optional)."
							bind:checked={form.pomodoroEnabled}
							onCheckedChange={() => saveTracking()}
						/>
						{#if form.pomodoroEnabled}
							<div class="grid grid-cols-2 gap-2">
								<div class="space-y-1">
									<Label for="pomomin">Fokus (Min)</Label>
									<Input id="pomomin" type="number" min="1" bind:value={form.pomodoroMin} onchange={saveTracking} />
								</div>
								<div class="space-y-1">
									<Label for="pomobreak">Pause (Min, 0 = aus)</Label>
									<Input id="pomobreak" type="number" min="0" bind:value={form.pomodoroBreakMin} onchange={saveTracking} />
								</div>
							</div>
						{/if}

						<SettingRow
							title="Globaler Start/Stop-Hotkey"
							description="Startet/stoppt den zuletzt benutzten Timer – auch wenn die App im Hintergrund ist."
						>
							{#snippet control()}
								<div class="flex items-center gap-1">
									{#if recordingToggle}
										<span class="text-muted-foreground text-sm italic">Taste drücken… (Esc=Abbruch)</span>
									{:else if app.settings.toggleShortcut}
										<ShortcutKey
											shortcut={app.settings.toggleShortcut}
											onclick={() => (recordingToggle = true)}
										/>
										<Button variant="ghost" size="icon-sm" onclick={clearToggle} title="Entfernen">
											<XIcon />
										</Button>
									{:else}
										<!-- Festlegen ist eine Aktion, keine Taste – also ein normaler Button
										     statt der Keycap-Optik, die es vorher trug. -->
										<Button variant="outline" size="sm" onclick={() => (recordingToggle = true)}>
											Festlegen…
										</Button>
									{/if}
								</div>
							{/snippet}
						</SettingRow>

					</Card.Content>
				</Card.Root>
				<Card.Root>
					<Card.Header>
						<Card.Title>Arbeitszeit</Card.Title>
						<Card.Description>Arbeitstage & -zeit – Basis für Abwesenheiten und Bericht.</Card.Description>
						<Card.Action><SavedHint at={savedWorktime} /></Card.Action>
					</Card.Header>
					<Card.Content class="space-y-3">
						<div class="space-y-1">
							<Label>An welchen Tagen arbeitest du?</Label>
							<WorkdayPicker bind:value={form.workdays} onchange={saveWorktime} />
							<p class="text-muted-foreground text-xs">
								Nicht-Arbeitstage (z.&nbsp;B. Wochenende) werden beim Kalender-Import und bei
								Abwesenheits-Zeiträumen übersprungen und tauchen nicht im Bericht auf.
							</p>
						</div>
						<SettingRow
							id="tz"
							title="Zeitzone"
							description="Bestimmt, wo ein Arbeitstag anfängt und aufhört. Beim Wechsel rutschen bereits erfasste Einträge auf einen anderen Kalendertag."
							class="border-t pt-3"
						>
							{#snippet control()}
								<select
									id="tz"
									class="border-input bg-background ring-offset-background focus-visible:ring-ring h-9 w-56 rounded-md border px-3 py-1 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
									value={app.settings.timeZone}
									onchange={(e) => saveTimeZone(e.currentTarget.value)}
								>
									{#each timeZones as tz (tz)}
										<option value={tz}>{tz}</option>
									{/each}
								</select>
							{/snippet}
						</SettingRow>
						<SettingRow
							id="hpd"
							title="Stunden / Arbeitstag"
							description="Als Uhrzeit, z. B. 07:30. Ganzer Abwesenheitstag = dieser Wert."
							class="border-t pt-3"
						>
							{#snippet control()}
								<Input id="hpd" type="time" class="w-32" bind:value={form.hoursPerDay} onchange={saveWorktime} />
							{/snippet}
						</SettingRow>
						<SettingToggle
							id="breakded"
							title="Pause automatisch abziehen"
							description="Ab 4 h Tagesarbeitszeit 15 Minuten, ab 6 h insgesamt 45 – wie LOGA es rechnet. Wirkt auf Tagessummen, Bericht und Auswertung; die erfassten Einträge bleiben unverändert."
							bind:checked={form.breakDeduction}
							onCheckedChange={() => saveWorktime()}
							class="border-t pt-3"
						/>
						<SettingRow id="round" title="Rundung" description="Stunden je Aktivität im Bericht." class="border-t pt-3">
							{#snippet control()}
								<Select.Root type="single" bind:value={form.rounding} onValueChange={() => saveWorktime()}>
									<Select.Trigger id="round" class="w-48">{ROUNDINGS[form.rounding] ?? form.rounding}</Select.Trigger>
									<Select.Content>
										{#each Object.entries(ROUNDINGS) as [v, label] (v)}
											<Select.Item value={v} {label}>{label}</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
							{/snippet}
						</SettingRow>
					</Card.Content>
				</Card.Root>
		{:else if bereich === "bericht"}
				<Card.Root>
					<Card.Header>
						<Card.Title>Bericht & E-Mail</Card.Title>
						<Card.Action><SavedHint at={savedReport} /></Card.Action>
					</Card.Header>
					<Card.Content class="space-y-3">
						<div class="space-y-1">
							<Label for="boss">E-Mail der/des Vorgesetzten</Label>
							<Input id="boss" type="email" bind:value={form.bossEmail} placeholder="name@firma.de" onchange={saveReport} />
						</div>
						<div class="space-y-1">
							<Label for="sender">Dein Name (optional)</Label>
							<Input id="sender" bind:value={form.senderName} onchange={saveReport} />
						</div>
						<div class="space-y-1">
							<Label for="subj">Betreff-Vorlage</Label>
							<Input id="subj" bind:value={form.reportSubjectTemplate} onchange={saveReport} />
							<p class="text-muted-foreground text-xs">
								{"{month}"} = Monat, {"{name}"} = dein Name
							</p>
						</div>
						<SettingToggle
							id="stats"
							title="Auswertung anzeigen"
							description="Saldo, Stunden je Aktivität und Jahres-Heatmap im Tab „Bericht“. Nur für dich – die E-Mail bleibt unverändert."
							bind:checked={form.statsEnabled}
							onCheckedChange={() => saveReport()}
							class="border-t pt-3"
						/>
						<SettingToggle
							id="arbzg"
							title="Arbeitszeit-Check anzeigen"
							description="Schätzt nach dem Arbeitszeitgesetz, ob der 24-Wochen-Schnitt von 8 h zu reißen droht, und was sich am Tempo ändern müsste. Nur für dich – die E-Mail bleibt unverändert."
							bind:checked={form.arbzgEnabled}
							onCheckedChange={() => saveReport()}
						/>
						<SettingToggle
							id="arbzghint"
							title="Hinweis beim Tracking"
							description="Zeigt oben auf der Tracking-Seite eine Zeile, wenn der 24-Wochen-Schnitt zu reißen droht. Schweigt, solange alles im grünen Bereich ist."
							bind:checked={form.arbzgTrackingHint}
							onCheckedChange={() => saveReport()}
						/>
					</Card.Content>
				</Card.Root>
				<Card.Root>
					<Card.Header>
						<Card.Title>Chef-Modus</Card.Title>
						<Card.Description>
							Prüft im Outlook-Posteingang, wer seinen Monatsbericht geschickt hat und wer nicht.
						</Card.Description>
						<Card.Action><SavedHint at={savedBoss} /></Card.Action>
					</Card.Header>
					<Card.Content class="space-y-3">
						<SettingToggle
							id="bossmode"
							title="Chef-Modus"
							description="Blendet den Tab „Team“ ein. Es wird ausschließlich gelesen – keine Mail wird verschoben oder markiert."
							bind:checked={form.bossMode}
							onCheckedChange={() => saveBossMode()}
						/>

						{#if form.bossMode}
							<div class="space-y-2 border-t pt-3">
								<Label>Team</Label>
								<p class="text-muted-foreground text-xs">
									Von wem monatlich ein Bericht erwartet wird. Die Zuordnung läuft über die E-Mail-Adresse
									– fehlt jemand hier, taucht sein Bericht trotzdem auf, nur eben ohne „fehlt“-Abgleich.
								</p>
								<!-- Nach id, nicht nach Index: beim Loeschen einer Zeile ruecken sonst
								     alle folgenden Felder eine Position hoch und zeigen fremde Werte. -->
								{#each form.team as m, i (m.id)}
									<div class="flex gap-2">
										<Input placeholder="Name" bind:value={form.team[i].name} onchange={saveBossMode} />
										<Input
											type="email"
											placeholder="name@firma.de"
											bind:value={form.team[i].email}
											onchange={saveBossMode}
										/>
										<Button
											variant="ghost"
											size="icon"
											title="Aus dem Team entfernen"
											onclick={() => {
												form.team = form.team.filter((_, j) => j !== i);
												void saveBossMode();
											}}
										>
											<Trash2Icon class="size-4" />
										</Button>
									</div>
								{/each}
								<Button
									variant="outline"
									size="sm"
									onclick={() => (form.team = [...form.team, { id: crypto.randomUUID(), name: "", email: "" }])}
								>
									<PlusIcon class="size-4" /> Mitarbeiter
								</Button>
							</div>

							<div class="space-y-1 border-t pt-3">
								<Label for="tsubj">Betreff enthält</Label>
								<Input id="tsubj" bind:value={form.teamSubjectFilter} onchange={saveBossMode} />
								<p class="text-muted-foreground text-xs">
									Nur Mails mit diesem Text im Betreff werden gelesen. Standard ist der Anfang der
									Betreff-Vorlage, die TimeTracker selbst verschickt.
								</p>
							</div>

							<SettingToggle
								id="tsubf"
								title="Unterordner mitlesen"
								description="Auch Unterordner des Posteingangs durchsuchen – für alle, die Berichte per Regel einsortieren lassen."
								bind:checked={form.teamScanSubfolders}
								onCheckedChange={() => saveBossMode()}
							/>
						{/if}
					</Card.Content>
				</Card.Root>
		{:else if bereich === "erinnerungen"}
				<Card.Root>
					<Card.Header>
						<Card.Title>Erinnerungen</Card.Title>
						<Card.Action><SavedHint at={savedTimes} /></Card.Action>
					</Card.Header>
					<Card.Content class="space-y-3">
						<p class="text-muted-foreground text-sm">
							Zu diesen Uhrzeiten erinnert dich die App, deine Zeiten einzutragen.
						</p>
						{#each form.reminderTimes as _, i (i)}
							<div class="flex gap-2">
								<Input type="time" bind:value={form.reminderTimes[i]} onchange={saveTimes} />
								<Button
									variant="ghost"
									size="icon"
									title="Uhrzeit entfernen"
									onclick={() => {
										form.reminderTimes = form.reminderTimes.filter((_, j) => j !== i);
										void saveTimes();
									}}
								>
									<Trash2Icon class="size-4" />
								</Button>
							</div>
						{/each}
						<div class="flex gap-2">
							<Button
								variant="outline"
								size="sm"
								onclick={() => {
									form.reminderTimes = [...form.reminderTimes, "14:00"];
									// Ohne Speichern-Button muss das Anlegen selbst persistieren – sonst
									// stuende die neue Zeit nur im Fenster und waere beim Neustart weg.
									void saveTimes();
								}}
							>
								<PlusIcon class="size-4" /> Uhrzeit
							</Button>
						</div>

						<div class="space-y-2 border-t pt-3">
							<SettingToggle
								id="reprem"
								title="Monatlicher Bericht-Hinweis"
								description="Am letzten Werktag erinnern, den Bericht zu senden."
								bind:checked={form.reportReminderEnabled}
								onCheckedChange={() => saveTimes()}
							/>
							{#if form.reportReminderEnabled}
								<SettingRow id="replead" title="Werktage vorher" description="0 = letzter Werktag.">
									{#snippet control()}
										<Input
											id="replead"
											type="number"
											min="0"
											max="10"
											class="w-24"
											bind:value={form.reportReminderLeadDays}
											onchange={saveTimes}
										/>
									{/snippet}
								</SettingRow>
								<SettingRow id="reptime" title="Uhrzeit" description="Wann an diesem Tag erinnert wird.">
									{#snippet control()}
										<Input id="reptime" type="time" class="w-32" bind:value={form.reportReminderTime} onchange={saveTimes} />
									{/snippet}
								</SettingRow>
							{/if}
						</div>

					</Card.Content>
				</Card.Root>
		{:else if bereich === "konto"}
				<AccountPanel />
				<AdminPanel />
		{:else if bereich === "system"}
				<Card.Root>
					<Card.Header>
						<Card.Title>System</Card.Title>
						<Card.Action><SavedHint at={savedSystem} /></Card.Action>
					</Card.Header>
					<Card.Content class="space-y-4">
						<SettingToggle
							id="autostart"
							title="Mit Windows starten"
							description="App läuft im Hintergrund (Tray)."
							bind:checked={form.autostart}
							onCheckedChange={toggleAutostart}
						/>
						<SettingToggle
							id="beta"
							title="Vorabversionen (Beta)"
							description="Neue Funktionen früher bekommen – dafür kann auch mal etwas klemmen. Aus heißt: nur fertige Versionen."
							bind:checked={form.betaUpdates}
							onCheckedChange={saveBetaUpdates}
							class="border-t pt-3"
						/>
						{#if channelChanged}
							<!-- Der Kanal steht fest, sobald das Updater-Plugin seine Konfiguration
							     gelesen hat – das passiert beim Start, lange bevor dieser Schalter
							     erreichbar ist. Ohne diesen Hinweis suchte die App weiter im alten
							     Kanal, ohne dass erkennbar wäre, warum. -->
							<div class="flex flex-wrap items-center gap-2 text-sm">
								<span class="text-muted-foreground">Wirkt nach einem Neustart der App.</span>
								<Button variant="outline" size="sm" onclick={restartApp}>Jetzt neu starten</Button>
							</div>
						{/if}
						<Button variant="outline" onclick={checkUpdate} disabled={updater.checking}>
							{updater.checking ? "Suche…" : "Nach Updates suchen"}
						</Button>
					</Card.Content>
				</Card.Root>
				<Card.Root>
					<Card.Header>
						<Card.Title>Daten</Card.Title>
						<Card.Description>
							Erfasste Zeiten bleiben liegen, bis du sie löschst. Es wird nichts automatisch entfernt.
						</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-3">
						{#if years.length === 0}
							<p class="text-muted-foreground text-sm">Noch keine erfassten Zeiten.</p>
						{:else}
							{#each years as y (y.year)}
								<div class="flex items-center justify-between gap-3 border-b pb-2 last:border-0">
									<div>
										<div class="text-sm font-medium">{y.year}</div>
										<div class="text-muted-foreground text-xs">
											{y.months} Monat{y.months === 1 ? "" : "e"} · {y.entries} Eintr{y.entries === 1
												? "ag"
												: "äge"}
										</div>
									</div>
									<Button variant="outline" size="sm" onclick={() => (yearToDelete = y)}>
										<Trash2Icon class="size-4" /> Löschen
									</Button>
								</div>
							{/each}
						{/if}
					</Card.Content>
				</Card.Root>
		{:else if bereich === "ueber"}
				<Card.Root>
					<Card.Header><Card.Title>Datenschutz</Card.Title></Card.Header>
					<Card.Content class="space-y-3">
						<SettingToggle
							id="errreports"
							title="Anonyme Fehlermeldungen senden"
							description="Hilft, Abstürze und Fehler zu finden, die nur auf anderen Rechnern auftreten."
							bind:checked={form.errorReportsEnabled}
							onCheckedChange={() => saveErrorReports()}
						/>

						<div class="text-muted-foreground space-y-2 border-t pt-3 text-xs">
							<p>
								<span class="text-foreground font-medium">Mit diesem Schalter:</span> der Text von Fehlermeldungen
								und Abstürzen, bereinigt um Dateipfade, Adressen und lange Zahlen. Nie das Detail dazu – dort
								stünden Aufruflisten und Dateinamen.
							</p>
							<p>
								<span class="text-foreground font-medium">Nie:</span> Aktivitäten, Projekte, Notizen, Zeiten,
								Namen, E-Mail-Adressen, Dateien – nichts aus deinen Einträgen. Es gibt keine Kennung, die dich
								über Programmstarts hinweg wiedererkennt, und keine gespeicherte IP-Adresse. Start- und Endzeiten
								des Programms werden bewusst nicht gemeldet, weil sich daraus deine Arbeitszeiten ablesen ließen.
							</p>
							<p>
								Verarbeitet wird über Aptabase (EU-Server). Es fallen keine personenbezogenen Daten an.
							</p>
						</div>
					</Card.Content>
				</Card.Root>
				<LogPanel />
				<Card.Root>
					<Card.Header><Card.Title>Über</Card.Title></Card.Header>
					<Card.Content class="space-y-3">
						<div class="flex items-center gap-3">
							<button type="button" class="cursor-none" onclick={tapLogo} aria-label="TimeTracker">
								<img src="/logo.svg" alt="TimeTracker" class="h-10 w-auto" />
							</button>
							<div>
								<div class="flex items-center gap-1.5">
									<span class="text-sm font-medium">TimeTracker</span>
									{#if app.devMode}
										<span
											class="bg-primary/10 text-primary inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
											title="Dev-Modus aktiv"
										>
											<WrenchIcon class="size-3" /> Dev
										</span>
									{/if}
								</div>
								<div class="text-muted-foreground text-xs">Version {appVersion || "—"}</div>
							</div>
						</div>
						<div class="flex flex-wrap gap-2">
							<Button variant="outline" size="sm" onclick={() => openExternal(REPO_URL)}>
								<ExternalLinkIcon class="size-4" /> GitHub
							</Button>
						</div>
						<p class="text-muted-foreground text-xs">
							Zeiterfassung für Projektzeiten mit Monatsbericht.
						</p>

						{#if app.devMode}
							<div class="border-t pt-3">
								<div class="text-muted-foreground mb-2 text-xs font-medium">Dev</div>
								<div class="flex flex-wrap gap-2">
									<Button variant="secondary" size="sm" onclick={showFlyout}>Tray-Flyout anzeigen</Button>
								</div>
								<div class="text-muted-foreground mt-3 mb-1.5 text-xs">Modals öffnen</div>
								<div class="flex flex-wrap gap-2">
									<Button variant="secondary" size="sm" onclick={() => app.openOnboarding()}>
										Willkommensbildschirm
									</Button>
									<Button variant="secondary" size="sm" onclick={devTriggerLongTimer}>
										Langzeit-Timer
									</Button>
									<Button variant="secondary" size="sm" onclick={devTriggerIdle}>Leerlauf</Button>
									<Button variant="secondary" size="sm" onclick={devTriggerReportReminder}>
										Berichts-Erinnerung
									</Button>
								</div>
								<div class="text-muted-foreground mt-3 mb-1.5 text-xs">Ladebildschirm</div>
								<div class="flex flex-wrap gap-2">
									<Button
										variant="secondary"
										size="sm"
										title="Startet die App neu und lässt den Schritt „Einträge laden“ scheitern. „Erneut versuchen“ bringt alles zurück."
										onclick={() => app.devSimulateStartFault("error")}
									>
										Startfehler
									</Button>
									<Button
										variant="secondary"
										size="sm"
										title="Startet die App neu und hält den Schritt „Einträge laden“ 20 s auf – danach läuft er von selbst weiter."
										onclick={() => app.devSimulateStartFault("hang")}
									>
										Start hängen lassen
									</Button>
								</div>
								<p class="text-muted-foreground mt-1.5 text-xs">
									Beide durchlaufen den echten Startweg. An den erfassten Zeiten ändert sich nichts, ein
									laufender Timer zählt weiter.
								</p>
							</div>
						{/if}
					</Card.Content>
				</Card.Root>
		{/if}
	</div>
</div>

<!-- Loeschen ist endgueltig: kein Papierkorb, kein Backup. Deshalb wird vorher
     genannt, was genau verschwindet. -->
<Dialog.Root open={yearToDelete !== null} onOpenChange={(o) => !o && (yearToDelete = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>{yearToDelete?.year} löschen?</Dialog.Title>
			<Dialog.Description>
				{yearToDelete?.entries} Einträge aus {yearToDelete?.months} Monat{yearToDelete?.months === 1
					? ""
					: "e"} werden endgültig gelöscht. Das lässt sich nicht rückgängig machen.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" disabled={deleting} onclick={() => (yearToDelete = null)}>
				Abbrechen
			</Button>
			<Button disabled={deleting} onclick={confirmDeleteYear}>
				{deleting ? "Lösche…" : `${yearToDelete?.year} endgültig löschen`}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<svelte:window onkeydown={onToggleKey} />
