<script lang="ts">
	import { onDestroy } from "svelte";
	import { app } from "$lib/app.svelte";
	import { account } from "$lib/sync/account.svelte";
	import { DEFAULT_SERVER } from "$lib/defaults";
	import { clockToMin } from "$lib/time";
	import { scheduleReminders } from "$lib/reminders";
	import { errorText, logInfo, logWarn } from "$lib/log";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Switch } from "$lib/components/ui/switch";
	import { Textarea } from "$lib/components/ui/textarea";
	import WorkdayPicker from "$lib/components/shared/WorkdayPicker.svelte";
	import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
	import { capabilities } from "$lib/platform/env";
	import { openExternal } from "$lib/platform/open";
	import { anlegenLink } from "$lib/invite";
	import { toast } from "svelte-sonner";
	import TimerIcon from "@lucide/svelte/icons/timer";
	import MailIcon from "@lucide/svelte/icons/mail";
	import PalmtreeIcon from "@lucide/svelte/icons/palmtree";
	import BellIcon from "@lucide/svelte/icons/bell";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";
	import PlusIcon from "@lucide/svelte/icons/plus";
	import CloudIcon from "@lucide/svelte/icons/cloud";
	import ShieldCheckIcon from "@lucide/svelte/icons/shield-check";
	import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
	import KeyRoundIcon from "@lucide/svelte/icons/key-round";
	import SmartphoneIcon from "@lucide/svelte/icons/smartphone";
	import CheckCircle2Icon from "@lucide/svelte/icons/check-circle-2";

	const STEPS = 5;
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

	// Server / Cloud Sync im Onboarding
	let serverUrl = $state(
		account.serverUrl || (typeof localStorage !== "undefined" && localStorage.getItem("preferred_server_url")) || DEFAULT_SERVER
	);
	let isStartingSync = $state(false);
	let isWaitingForApproval = $state(false);
	let pairingCode = $state("");
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	function suggestDeviceName(): string {
		const p = navigator.platform || "Gerät";
		return capabilities.tray ? `Rechner (${p})` : `Browser (${p})`;
	}

	async function handleStartRegistration() {
		const url = serverUrl.trim();
		if (!url) {
			toast.error("Bitte die Adresse des Servers angeben.");
			return;
		}
		if (typeof localStorage !== "undefined") {
			localStorage.setItem("preferred_server_url", url);
		}
		isStartingSync = true;
		try {
			pairingCode = await account.startPairing(url, suggestDeviceName());
			isWaitingForApproval = true;
			pollTimer = setInterval(checkPairingStatus, 2000);
			await openExternal(anlegenLink(url));
		} catch (e) {
			toast.error(errorText(e));
		} finally {
			isStartingSync = false;
		}
	}

	async function handleStartPairing() {
		const url = serverUrl.trim();
		if (!url) {
			toast.error("Bitte die Adresse des Servers angeben.");
			return;
		}
		if (typeof localStorage !== "undefined") {
			localStorage.setItem("preferred_server_url", url);
		}
		isStartingSync = true;
		try {
			pairingCode = await account.startPairing(url, suggestDeviceName());
			isWaitingForApproval = true;
			pollTimer = setInterval(checkPairingStatus, 2000);
		} catch (e) {
			toast.error(errorText(e));
		} finally {
			isStartingSync = false;
		}
	}

	async function checkPairingStatus() {
		try {
			if (await account.checkPairing()) {
				cancelPairingFlow();
				toast.success("Gerät erfolgreich mit Server verknüpft!");
			}
		} catch (e) {
			cancelPairingFlow();
			toast.error(errorText(e));
		}
	}

	function cancelPairingFlow() {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = null;
		isWaitingForApproval = false;
		pairingCode = "";
		account.cancelPairing();
	}

	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
	});

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
		{ icon: MailIcon, title: "Monatsbericht", text: "Erfasste Stunden und sende diese, am Monatsende, einfach an deine Vorgesetzten." },
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
		cancelPairingFlow();
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
		logInfo("Willkommens-Assistent abgeschlossen", {
			name: senderName.trim(),
			vorgesetzte: bossEmail.trim(),
			stundenProTag: hpd,
			arbeitstage: workdays.length,
			erinnerungen: cleanTimes.length
		});
		scheduleReminders();
		try {
			if (autostart) {
				if (!(await isEnabled())) await enable();
			} else if (await isEnabled()) {
				await disable();
			}
		} catch (e) {
			logWarn("Autostart konnte nicht gesetzt werden", e);
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

<div
	class="bg-background fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
>
	<div class="my-auto w-full max-w-lg space-y-6">
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
					<Label for="ob-boss">E-Mail der/des Vorgesetzten</Label>
					<Input
						id="ob-boss"
						type="email"
						placeholder="name@firma.de"
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
		{:else if step === 3}
			<div class="space-y-1 text-center">
				<h1 class="text-xl font-semibold">Cloud & Geräte-Abgleich</h1>
				<p class="text-muted-foreground text-sm">
					Optional: Sichere deine Zeiten automatisch und greife von überall darauf zu.
				</p>
			</div>

			<!-- Vorteile -->
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
				<div class="flex items-start gap-2.5 rounded-lg border bg-card/60 p-2.5 text-left">
					<ShieldCheckIcon class="size-4 text-emerald-500 shrink-0 mt-0.5" />
					<div>
						<div class="text-xs font-medium text-foreground">Ende-zu-Ende verschlüsselt</div>
						<div class="text-[11px] text-muted-foreground leading-snug">Zero-Knowledge: Niemand außer dir kann deine Zeiten im Klartext lesen.</div>
					</div>
				</div>
				<div class="flex items-start gap-2.5 rounded-lg border bg-card/60 p-2.5 text-left">
					<RefreshCwIcon class="size-4 text-blue-500 shrink-0 mt-0.5" />
					<div>
						<div class="text-xs font-medium text-foreground">Nahtloser Multi-Device-Sync</div>
						<div class="text-[11px] text-muted-foreground leading-snug">Zeiten synchron auf PC, Mac, Smartphone & Web erfassen.</div>
					</div>
				</div>
				<div class="flex items-start gap-2.5 rounded-lg border bg-card/60 p-2.5 text-left">
					<CloudIcon class="size-4 text-sky-500 shrink-0 mt-0.5" />
					<div>
						<div class="text-xs font-medium text-foreground">Automatisches Backup</div>
						<div class="text-[11px] text-muted-foreground leading-snug">Kein Datenverlust bei Hardware-Defekt oder neuem Computer.</div>
					</div>
				</div>
				<div class="flex items-start gap-2.5 rounded-lg border bg-card/60 p-2.5 text-left">
					<KeyRoundIcon class="size-4 text-amber-500 shrink-0 mt-0.5" />
					<div>
						<div class="text-xs font-medium text-foreground">Passkey-Anmeldung</div>
						<div class="text-[11px] text-muted-foreground leading-snug">Ohne Passwort per Touch ID, Windows Hello oder Face ID.</div>
					</div>
				</div>
			</div>

			<!-- Interaktive Verbindung / Status -->
			{#if account.linked}
				<div class="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3.5 text-xs text-emerald-900 dark:text-emerald-200">
					<CheckCircle2Icon class="size-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
					<div>
						<div class="font-medium text-sm">Bereits erfolgreich verknüpft</div>
						<div class="opacity-90">{account.serverUrl}</div>
					</div>
				</div>
			{:else if isWaitingForApproval}
				<div class="space-y-3 rounded-lg border bg-muted/40 p-4 text-center">
					<div class="text-xs text-muted-foreground font-medium">Dein Kopplungscode</div>
					<div class="font-mono text-2xl tracking-widest font-semibold text-primary select-all">
						{pairingCode || "…"}
					</div>
					<p class="text-xs text-muted-foreground">
						Bestätige diesen Code im geöffneten Browserfenster oder auf deinem anderen Gerät.
					</p>
					<Button variant="ghost" size="sm" onclick={cancelPairingFlow} class="text-xs">
						Abbrechen
					</Button>
				</div>
			{:else}
				<div class="space-y-3 rounded-lg border bg-card p-3.5">
					<div class="space-y-1 text-left">
						<Label for="ob-server" class="text-xs">Server-Adresse</Label>
						<Input
							id="ob-server"
							type="url"
							placeholder="https://tt.example.de"
							bind:value={serverUrl}
							class="text-xs font-mono h-8"
						/>
					</div>

					<div class="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
						<Button
							class="w-full gap-1.5 text-xs"
							size="sm"
							disabled={isStartingSync}
							onclick={handleStartRegistration}
						>
							<KeyRoundIcon class="size-3.5 shrink-0" />
							<span>Konto anlegen / anmelden</span>
						</Button>
						<Button
							variant="outline"
							class="w-full gap-1.5 text-xs"
							size="sm"
							disabled={isStartingSync}
							onclick={handleStartPairing}
						>
							<SmartphoneIcon class="size-3.5 shrink-0" />
							<span>Gerät koppeln</span>
						</Button>
					</div>

					<p class="text-muted-foreground text-[11px] text-center pt-1 border-t">
						Du kannst diesen Schritt überspringen und TimeTracker rein lokal nutzen.
					</p>
				</div>
			{/if}
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

		<!-- Kein „Überspringen“: jeder Schritt laesst sich leer bestaetigen, aber
		     wegklicken soll niemand koennen, ohne die Moeglichkeiten gesehen zu haben.

		     Ausnahme nur hier: wer gerade ein Konto angelegt hat und ein Geraet
		     koppeln will, hat seine Einstellungen schon - nur noch nicht lokal.
		     Ausgefuellte Felder wuerden beim Zusammenfuehren mit frischem Zeitstempel
		     gegen die echten Werte gewinnen. -->
		<div class="flex items-center justify-between gap-2">
			{#if account.linked}
				<Button variant="ghost" onclick={() => app.dismissOnboarding()} disabled={saving}>
					Meine Daten liegen auf einem anderen Gerät
				</Button>
			{:else}
				<span></span>
			{/if}
			<div class="flex items-center gap-2">
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
