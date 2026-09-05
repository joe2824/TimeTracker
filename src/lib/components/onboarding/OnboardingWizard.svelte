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
	import { openExternal } from "$lib/platform/open";
	import { createLink } from "$lib/invite";
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
	import PairingCode from "$lib/components/onboarding/PairingCode.svelte";
	import { PairingFlow } from "$lib/pairingFlow.svelte";

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

	const pairing = new PairingFlow({
		done: () => toast.success("Gerät erfolgreich mit Server verknüpft!"),
		failed: (e) => toast.error(errorText(e))
	});

	/** `openBrowser`: erst das Konto im Browser anlegen, dann hier bestätigen. */
	async function beginPairing(openBrowser: boolean) {
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
			await pairing.start(url);
			if (openBrowser) await openExternal(createLink(url));
		} catch (e) {
			toast.error(errorText(e));
		} finally {
			isStartingSync = false;
		}
	}

	onDestroy(() => pairing.stop());

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

	const stepTitles = [
		{
			title: "Willkommen bei TimeTracker",
			subtitle: "In wenigen Schritten eingerichtet. Das kannst du damit tun:"
		},
		{
			title: "Deine Angaben",
			subtitle: "Für den Monatsbericht – später jederzeit änderbar."
		},
		{
			title: "Aktivitäten",
			subtitle: "Deine Projekte & Tätigkeiten – eine je Zeile. Später änderbar."
		},
		{
			title: "Cloud & Geräte-Abgleich",
			subtitle: "Optional: Sichere deine Zeiten automatisch und greife von überall darauf zu."
		},
		{
			title: "Erinnerung & Start",
			subtitle: "Damit du das Erfassen im Alltag nicht vergisst."
		}
	];

	const features = [
		{ icon: TimerIcon, title: "Timer & Tracking", text: "Zeit pro Aktivität starten/stoppen – auch per globalem Hotkey." },
		{ icon: MailIcon, title: "Monatsbericht", text: "Erfasste Stunden am Monatsende einfach an Vorgesetzte senden." },
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
		pairing.cancel();
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
			supervisors: bossEmail.trim(),
			hoursPerDayValue: hpd,
			workdayCount: workdays.length,
			reminders: cleanTimes.length
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
	class="bg-background/80 fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm overflow-hidden"
>
	<div
		class="bg-card text-card-foreground border-border/80 flex h-[600px] max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border shadow-2xl"
	>
		<!-- Fester Kopfbereich: Bild & Titel springen nie -->
		<div class="px-6 pt-5 pb-2 text-center shrink-0 space-y-2">
			<div class="flex items-center justify-center">
				<img src="/logo.svg" alt="TimeTracker" class="h-10 w-auto" />
			</div>
			<div class="space-y-0.5 min-h-[44px] flex flex-col justify-center">
				<h1 class="text-lg font-semibold tracking-tight">{stepTitles[step].title}</h1>
				<p class="text-muted-foreground text-xs">{stepTitles[step].subtitle}</p>
			</div>
		</div>

		<!-- Scrollbarer Inhaltsbereich mit fester Höhe -->
		<div class="flex-1 overflow-y-auto px-6 py-2 min-h-0">
			{#if step === 0}
				<ul class="space-y-2.5 pt-1">
					{#each features as f (f.title)}
						{@const Icon = f.icon}
						<li class="flex items-start gap-3 rounded-lg border bg-muted/20 p-2.5">
							<div class="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-lg">
								<Icon class="size-4" />
							</div>
							<div>
								<div class="text-xs font-medium text-foreground">{f.title}</div>
								<div class="text-muted-foreground text-xs leading-snug">{f.text}</div>
							</div>
						</li>
					{/each}
				</ul>
			{:else if step === 1}
				<div class="space-y-3 pt-1">
					<div class="space-y-1">
						<Label for="ob-name" class="text-xs">Dein Name</Label>
						<Input id="ob-name" placeholder="z. B. Max Mustermann" bind:value={senderName} class="h-9 text-xs" />
					</div>
					<div class="space-y-1">
						<Label for="ob-boss" class="text-xs">E-Mail der/des Vorgesetzten</Label>
						<Input
							id="ob-boss"
							type="email"
							placeholder="name@firma.de"
							bind:value={bossEmail}
							aria-invalid={emailInvalid}
							class="h-9 text-xs"
						/>
						{#if emailInvalid}
							<p class="text-destructive text-[11px]">Sieht das nach einer gültigen E-Mail aus?</p>
						{/if}
					</div>
					<div class="space-y-1">
						<Label for="ob-hpd" class="text-xs">Arbeitszeit pro Tag</Label>
						<Input id="ob-hpd" type="time" bind:value={workTime} class="w-32 h-9 text-xs" />
						<p class="text-muted-foreground text-[11px]">
							Basis für die Soll-Arbeitszeit und Abwesenheiten.
						</p>
					</div>
					<div class="space-y-1">
						<Label class="text-xs">An welchen Tagen arbeitest du?</Label>
						<WorkdayPicker bind:value={workdays} />
					</div>
				</div>
			{:else if step === 2}
				<div class="space-y-2 pt-1">
					<Textarea
						bind:value={activitiesText}
						placeholder={"Projekt 1\nProjekt 2\nProjekt 3\n…"}
						rows={8}
						class="text-xs"
					/>
					<div class="flex items-center justify-between gap-2">
						<Button variant="outline" size="sm" onclick={() => fileInput?.click()} class="text-xs h-8">
							Aus Datei (.txt)…
						</Button>
						<input
							bind:this={fileInput}
							type="file"
							accept=".txt,.csv,.text"
							class="hidden"
							onchange={onActivityFile}
						/>
						<span class="text-muted-foreground text-[11px]">Duplikate werden ignoriert</span>
					</div>
				</div>
			{:else if step === 3}
				<div class="space-y-3 pt-1">
					<!-- Vorteile -->
					<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
						<div class="flex items-start gap-2 rounded-lg border bg-muted/20 p-2 text-left">
							<ShieldCheckIcon class="size-4 text-emerald-500 shrink-0 mt-0.5" />
							<div>
								<div class="text-xs font-medium text-foreground">Ende-zu-Ende verschlüsselt</div>
								<div class="text-[11px] text-muted-foreground leading-snug">Zero-Knowledge: Niemand außer dir kann deine Zeiten lesen.</div>
							</div>
						</div>
						<div class="flex items-start gap-2 rounded-lg border bg-muted/20 p-2 text-left">
							<RefreshCwIcon class="size-4 text-blue-500 shrink-0 mt-0.5" />
							<div>
								<div class="text-xs font-medium text-foreground">Multi-Device-Sync</div>
								<div class="text-[11px] text-muted-foreground leading-snug">Synchron auf PC, Mac, Smartphone & Web.</div>
							</div>
						</div>
						<div class="flex items-start gap-2 rounded-lg border bg-muted/20 p-2 text-left">
							<CloudIcon class="size-4 text-sky-500 shrink-0 mt-0.5" />
							<div>
								<div class="text-xs font-medium text-foreground">Automatisches Backup</div>
								<div class="text-[11px] text-muted-foreground leading-snug">Kein Datenverlust bei PC-Wechsel.</div>
							</div>
						</div>
						<div class="flex items-start gap-2 rounded-lg border bg-muted/20 p-2 text-left">
							<KeyRoundIcon class="size-4 text-amber-500 shrink-0 mt-0.5" />
							<div>
								<div class="text-xs font-medium text-foreground">Passkey-Anmeldung</div>
								<div class="text-[11px] text-muted-foreground leading-snug">Ohne Passwort per Touch ID / Windows Hello.</div>
							</div>
						</div>
					</div>

					<!-- Interaktive Verbindung / Status -->
					{#if account.linked}
						<div class="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-900 dark:text-emerald-200">
							<CheckCircle2Icon class="size-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
							<div>
								<div class="font-medium text-xs">Bereits erfolgreich verknüpft</div>
								<div class="opacity-90 font-mono text-[11px] truncate max-w-[280px]">{account.serverUrl}</div>
							</div>
						</div>
					{:else if pairing.waiting}
						<div class="rounded-lg border bg-muted/20 p-2">
							<PairingCode code={pairing.code} onCancel={() => pairing.cancel()} />
						</div>
					{:else}
						<div class="space-y-2.5 rounded-lg border bg-muted/10 p-3">
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

							<div class="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-0.5">
								<Button
									class="w-full gap-1.5 text-xs h-8"
									size="sm"
									disabled={isStartingSync}
									onclick={() => beginPairing(true)}
								>
									<KeyRoundIcon class="size-3.5 shrink-0" />
									<span class="truncate">Konto anlegen</span>
								</Button>
								<Button
									variant="outline"
									class="w-full gap-1.5 text-xs h-8"
									size="sm"
									disabled={isStartingSync}
									onclick={() => beginPairing(false)}
								>
									<SmartphoneIcon class="size-3.5 shrink-0" />
									<span class="truncate">Gerät koppeln</span>
								</Button>
							</div>

							<p class="text-muted-foreground text-[11px] text-center pt-1 border-t">
								Optional: TimeTracker kann auch rein lokal ohne Server genutzt werden.
							</p>
						</div>
					{/if}
				</div>
			{:else}
				<div class="space-y-4 pt-1">
					<div class="space-y-2">
						<Label class="text-xs">Tägliche Erinnerung um</Label>
						{#each times as _, i (i)}
							<div class="flex gap-2">
								<Input type="time" bind:value={times[i]} class="w-32 h-9 text-xs" />
								<Button
									variant="ghost"
									size="icon"
									class="size-9"
									onclick={() => (times = times.filter((_, j) => j !== i))}
								>
									<Trash2Icon class="size-4" />
								</Button>
							</div>
						{/each}
						<Button variant="outline" size="sm" onclick={() => (times = [...times, "14:00"])} class="text-xs h-8">
							<PlusIcon class="size-3.5" /> Uhrzeit hinzufügen
						</Button>
					</div>
					<div class="flex items-center justify-between gap-3 rounded-lg border p-3">
						<div>
							<Label for="ob-autostart" class="text-xs font-medium">Automatisch bei Login starten</Label>
							<p class="text-muted-foreground text-[11px]">Läuft dann versteckt im Hintergrund/Tray.</p>
						</div>
						<Switch id="ob-autostart" bind:checked={autostart} />
					</div>
				</div>
			{/if}
		</div>

		<!-- Fester Fußbereich: Fortschritt & Buttons an immer derselben Stelle -->
		<div class="border-t bg-muted/20 px-6 py-3.5 shrink-0 space-y-3">
			<!-- Schritt-Punkte -->
			<div class="flex items-center justify-center gap-1.5">
				{#each Array(STEPS) as _, i (i)}
					<span
						class="h-1.5 rounded-full transition-all duration-300 {i === step
							? 'bg-primary w-5'
							: 'bg-muted-foreground/30 w-1.5'}"
					></span>
				{/each}
			</div>

			<!-- Aktions-Buttons -->
			<div class="flex items-center justify-between gap-2">
				{#if account.linked}
					<Button variant="ghost" size="sm" onclick={() => app.dismissOnboarding()} disabled={saving} class="text-xs h-8 px-2 text-muted-foreground">
						Meine Daten liegen auf anderem Gerät
					</Button>
				{:else}
					<span></span>
				{/if}
				<div class="flex items-center gap-2">
					{#if step > 0}
						<Button variant="outline" size="sm" onclick={back} disabled={saving} class="text-xs h-8 min-w-[70px]">
							Zurück
						</Button>
					{/if}
					<Button size="sm" onclick={next} disabled={saving} class="text-xs h-8 min-w-[85px]">
						{step < STEPS - 1 ? "Weiter" : saving ? "Speichere…" : "Los geht's"}
					</Button>
				</div>
			</div>
		</div>
	</div>
</div>
