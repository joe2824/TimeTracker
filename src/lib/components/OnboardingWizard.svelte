<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { clockToMin } from "$lib/time";
	import { scheduleReminders } from "$lib/reminders";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Switch } from "$lib/components/ui/switch";
	import { Textarea } from "$lib/components/ui/textarea";
	import WorkdayPicker from "$lib/components/WorkdayPicker.svelte";
	import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
	import TimerIcon from "@lucide/svelte/icons/timer";
	import MailIcon from "@lucide/svelte/icons/mail";
	import PalmtreeIcon from "@lucide/svelte/icons/palmtree";
	import BellIcon from "@lucide/svelte/icons/bell";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";
	import PlusIcon from "@lucide/svelte/icons/plus";

	const STEPS = 4;
	let step = $state(0);
	let fileInput = $state<HTMLInputElement>();

	/** Dezimalstunden -> "HH:MM" (für das Zeit-Eingabefeld). */
	function hoursToTime(h: number): string {
		const total = Math.max(0, Math.round(h * 60));
		return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
	}

	// Felder mit den aktuellen Werten vorbelegen.
	let senderName = $state(app.settings.senderName);
	let bossEmail = $state(app.settings.bossEmail);
	let workTime = $state(hoursToTime(app.settings.hoursPerDay)); // Arbeitszeit/Tag als "HH:MM"
	let workdays = $state([...app.settings.workdays]);
	let times = $state<string[]>(
		app.settings.reminderTimes.length ? [...app.settings.reminderTimes] : ["14:00"]
	);
	let activitiesText = $state(""); // Aktivitäten-Import, eine je Zeile
	let autostart = $state(app.settings.autostart);
	let saving = $state(false);

	/** Aktivitäten aus einer Textdatei ins Eingabefeld übernehmen. */
	async function onActivityFile(ev: Event) {
		const input = ev.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const text = await file.text();
		activitiesText = activitiesText ? `${activitiesText}\n${text}` : text;
		input.value = "";
	}

	// Weicher Hinweis (nicht blockierend).
	const emailInvalid = $derived(
		bossEmail.trim() !== "" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(bossEmail.trim())
	);

	const features = [
		{ icon: TimerIcon, title: "Timer & Tracking", text: "Zeit pro Aktivität starten/stoppen – auch per globalem Hotkey." },
		{ icon: MailIcon, title: "Monatsbericht", text: "Erfasste Stunden und sende diese, am Monatsende, einfach an den Vorgesetzten." },
		{ icon: PalmtreeIcon, title: "Abwesenheiten", text: "Urlaub, Krankheit & Co. als ganze oder halbe Tage erfassen." },
		{ icon: BellIcon, title: "Erinnerungen", text: "Tägliche Erinnerung ans Erfassen und monatlich an den Bericht." }
	];

	function next() {
		if (step < STEPS - 1) step++;
		else void finish();
	}
	function back() {
		if (step > 0) step--;
	}

	async function persist() {
		// Aktivitäten importieren (jede Zeile eine; Duplikate ignoriert importActivities).
		const actLines = activitiesText.split(/\r?\n/);
		if (actLines.some((l) => l.trim())) await app.importActivities(actLines);

		const min = clockToMin(workTime);
		const hpd = min != null && min > 0 ? min / 60 : app.settings.hoursPerDay;
		const cleanTimes = times.filter((t) => t);
		await app.finishOnboarding({
			senderName: senderName.trim(),
			bossEmail: bossEmail.trim(),
			hoursPerDay: hpd,
			workdays: [...workdays].sort((a, b) => a - b),
			reminderTimes: cleanTimes,
			autostart
		});
		// Erinnerungen mit den neuen Zeiten neu planen.
		scheduleReminders();
		// Autostart-Wahl direkt anwenden (der Aufruf beim App-Start lief bereits vorher).
		try {
			if (autostart) {
				if (!(await isEnabled())) await enable();
			} else if (await isEnabled()) {
				await disable();
			}
		} catch (e) {
			console.error("Autostart konnte nicht gesetzt werden", e);
		}
	}

	async function finish() {
		if (saving) return;
		saving = true;
		try {
			await persist();
		} finally {
			saving = false;
		}
	}
</script>

<div class="bg-background fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4">
	<div class="w-full max-w-lg space-y-6">
		<div class="flex items-center justify-center">
			<img src="/logo.svg" alt="TimeTracker" class="h-14 w-auto" />
		</div>

		{#if step === 0}
			<div class="space-y-4 text-center">
				<h1 class="text-2xl font-semibold">Willkommen bei TimeTracker</h1>
				<p class="text-muted-foreground text-sm">
					In wenigen Schritten eingerichtet. Das kannst du damit tun:
				</p>
			</div>
			<ul class="space-y-3">
				{#each features as f (f.title)}
					{@const Icon = f.icon}
					<li class="flex items-start gap-3">
						<div class="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
							<Icon class="size-5" />
						</div>
						<div>
							<div class="text-sm font-medium">{f.title}</div>
							<div class="text-muted-foreground text-sm">{f.text}</div>
						</div>
					</li>
				{/each}
			</ul>
		{:else if step === 1}
			<div class="space-y-1 text-center">
				<h1 class="text-xl font-semibold">Deine Angaben</h1>
				<p class="text-muted-foreground text-sm">Für den Monatsbericht – später jederzeit änderbar.</p>
			</div>
			<div class="space-y-3">
				<div class="space-y-1">
					<Label for="ob-name">Dein Name</Label>
					<Input id="ob-name" placeholder="z. B. Max Mustermann" bind:value={senderName} />
				</div>
				<div class="space-y-1">
					<Label for="ob-boss">E-Mail des Vorgesetzten</Label>
					<Input
						id="ob-boss"
						type="email"
						placeholder="chef@firma.de"
						bind:value={bossEmail}
						aria-invalid={emailInvalid}
					/>
					{#if emailInvalid}
						<p class="text-destructive text-xs">Sieht das nach einer gültigen E-Mail aus?</p>
					{/if}
				</div>
				<div class="space-y-1">
					<Label for="ob-hpd">Arbeitszeit pro Tag</Label>
					<Input id="ob-hpd" type="time" bind:value={workTime} class="w-32" />
					<p class="text-muted-foreground text-xs">
						Als Zeit (z. B. 07:30). Basis für die Umrechnung von Abwesenheiten.
					</p>
				</div>
				<div class="space-y-1">
					<Label>An welchen Tagen arbeitest du?</Label>
					<WorkdayPicker bind:value={workdays} />
					<p class="text-muted-foreground text-xs">
						Standard Mo–Fr. Andere Tage (z. B. Wochenende) werden nicht importiert und tauchen nicht
						im Bericht auf – wichtig, falls du z. B. samstags arbeitest.
					</p>
				</div>
			</div>
		{:else if step === 2}
			<div class="space-y-1 text-center">
				<h1 class="text-xl font-semibold">Aktivitäten</h1>
				<p class="text-muted-foreground text-sm">
					Deine Projekte/Tätigkeiten – eine je Zeile. Später jederzeit änderbar.
				</p>
			</div>
			<div class="space-y-2">
				<Textarea
					bind:value={activitiesText}
					placeholder={"Projekt 1\nProjekt 2\nProjekt 3\n…"}
					rows={7}
				/>
				<div class="flex flex-wrap gap-2">
					<Button variant="outline" size="sm" onclick={() => fileInput?.click()}>
						Aus Datei (.txt)…
					</Button>
					<input
						bind:this={fileInput}
						type="file"
						accept=".txt,.csv,.text"
						class="hidden"
						onchange={onActivityFile}
					/>
				</div>
				<p class="text-muted-foreground text-xs">
					Vorhandene bleiben erhalten, Duplikate werden übersprungen. Kannst du auch leer lassen.
				</p>
			</div>
		{:else}
			<div class="space-y-1 text-center">
				<h1 class="text-xl font-semibold">Erinnerung & Start</h1>
				<p class="text-muted-foreground text-sm">Damit du das Erfassen nicht vergisst.</p>
			</div>
			<div class="space-y-4">
				<div class="space-y-2">
					<Label>Tägliche Erinnerung um</Label>
					{#each times as _, i (i)}
						<div class="flex gap-2">
							<Input type="time" bind:value={times[i]} class="w-32" />
							<Button
								variant="ghost"
								size="icon"
								onclick={() => (times = times.filter((_, j) => j !== i))}
							>
								<Trash2Icon class="size-4" />
							</Button>
						</div>
					{/each}
					<Button variant="outline" size="sm" onclick={() => (times = [...times, "14:00"])}>
						<PlusIcon class="size-4" /> Uhrzeit
					</Button>
				</div>
				<div class="flex items-center justify-between gap-3 rounded-lg border p-3">
					<div>
						<Label for="ob-autostart">Automatisch bei Login starten</Label>
						<p class="text-muted-foreground text-xs">Läuft dann versteckt im Tray.</p>
					</div>
					<Switch id="ob-autostart" bind:checked={autostart} />
				</div>
			</div>
		{/if}

		<!-- Schritt-Punkte -->
		<div class="flex items-center justify-center gap-2">
			{#each Array(STEPS) as _, i (i)}
				<span
					class="size-2 rounded-full transition-colors {i === step
						? 'bg-primary'
						: 'bg-muted-foreground/30'}"
				></span>
			{/each}
		</div>

		<!-- Kein „Überspringen“: wer den Assistenten wegklickt, sieht nie, was sich
		     überhaupt einstellen lässt. Jeder Schritt lässt sich leer bestätigen. -->
		<div class="flex items-center justify-end gap-2">
			{#if step > 0}
				<Button variant="outline" onclick={back} disabled={saving}>Zurück</Button>
			{/if}
			<Button onclick={next} disabled={saving}>
				{step < STEPS - 1 ? "Weiter" : saving ? "Speichere…" : "Los geht's"}
			</Button>
		</div>
	</div>
</div>
