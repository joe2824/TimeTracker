<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { parseHours } from "$lib/time";
	import { scheduleReminders } from "$lib/reminders";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Switch } from "$lib/components/ui/switch";
	import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
	import TimerIcon from "@lucide/svelte/icons/timer";
	import MailIcon from "@lucide/svelte/icons/mail";
	import PalmtreeIcon from "@lucide/svelte/icons/palmtree";
	import BellIcon from "@lucide/svelte/icons/bell";

	const STEPS = 3;
	let step = $state(0);

	// Felder mit den aktuellen Werten vorbelegen.
	let senderName = $state(app.settings.senderName);
	let bossEmail = $state(app.settings.bossEmail);
	let hoursPerDay = $state(String(app.settings.hoursPerDay).replace(".", ","));
	let reminderTime = $state(app.settings.reminderTimes[0] ?? "14:00");
	let autostart = $state(app.settings.autostart);
	let saving = $state(false);

	// Weicher Hinweis (nicht blockierend).
	const emailInvalid = $derived(
		bossEmail.trim() !== "" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(bossEmail.trim())
	);

	const features = [
		{ icon: TimerIcon, title: "Timer & Tracking", text: "Zeit pro Aktivität starten/stoppen – auch per globalem Hotkey." },
		{ icon: MailIcon, title: "Monatsbericht", text: "Erfasste Stunden als E-Mail-Entwurf an den Vorgesetzten." },
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
		const parsed = parseHours(hoursPerDay);
		// Nur die erste Erinnerungszeit setzen/ersetzen, evtl. weitere (Dev-Re-Trigger
		// bei Bestandsnutzern) erhalten.
		const rest = app.settings.reminderTimes.slice(1);
		await app.finishOnboarding({
			senderName: senderName.trim(),
			bossEmail: bossEmail.trim(),
			hoursPerDay: parsed && parsed > 0 ? parsed : app.settings.hoursPerDay,
			reminderTimes: [reminderTime, ...rest],
			autostart
		});
		// Erinnerungen mit der neuen Zeit neu planen.
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
					<Label for="ob-hpd">Arbeitsstunden pro Tag</Label>
					<Input id="ob-hpd" inputmode="decimal" placeholder="z. B. 7,5" bind:value={hoursPerDay} />
					<p class="text-muted-foreground text-xs">Basis für die Umrechnung von Abwesenheiten.</p>
				</div>
			</div>
		{:else}
			<div class="space-y-1 text-center">
				<h1 class="text-xl font-semibold">Erinnerung & Start</h1>
				<p class="text-muted-foreground text-sm">Damit du das Erfassen nicht vergisst.</p>
			</div>
			<div class="space-y-4">
				<div class="space-y-1">
					<Label for="ob-remind">Tägliche Erinnerung um</Label>
					<Input id="ob-remind" type="time" bind:value={reminderTime} class="w-32" />
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

		<div class="flex items-center justify-between gap-2">
			<Button variant="ghost" size="sm" disabled={saving} onclick={finish}>Überspringen</Button>
			<div class="flex gap-2">
				{#if step > 0}
					<Button variant="outline" onclick={back} disabled={saving}>Zurück</Button>
				{/if}
				<Button onclick={next} disabled={saving}>
					{step < STEPS - 1 ? "Weiter" : saving ? "Speichere…" : "Los geht's"}
				</Button>
			</div>
		</div>
	</div>
</div>
