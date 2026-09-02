<script lang="ts">
	import { onMount } from "svelte";
	import { app } from "$lib/app.svelte";
	import { Button } from "$lib/components/ui/button";
	import SettingsCard from "$lib/components/shared/SettingsCard.svelte";
	import LogPanel from "$lib/components/panels/LogPanel.svelte";
	import { APP_VERSION } from "$lib/defaults";
	import { account } from "$lib/sync/account.svelte";

	import { getVersion } from "@tauri-apps/api/app";
	import { invoke } from "@tauri-apps/api/core";
	import { openExternal } from "$lib/platform/open";
	import { isTauri } from "$lib/platform/env";
	import { errorText } from "$lib/log";
	import { toast } from "svelte-sonner";
	import {
		devTriggerIdle,
		devTriggerLongTimer,
		devTriggerReportReminder
	} from "$lib/watchers.svelte";
	import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
	import WrenchIcon from "@lucide/svelte/icons/wrench";
	import SparklesIcon from "@lucide/svelte/icons/sparkles";
	import { whatsNew } from "$lib/whatsNew.svelte";

	const REPO_URL = "https://github.com/joe2824/TimeTracker";

	let appVersion = $state(APP_VERSION);
	let logoTaps: number[] = [];

	onMount(async () => {
		try {
			appVersion = await getVersion();
		} catch {
			/* browser / non-tauri */
		}
	});

	function handleTapLogo() {
		const now = Date.now();
		logoTaps = logoTaps.filter((t) => now - t < 3000);
		logoTaps.push(now);
		if (!app.devMode && logoTaps.length >= 10) {
			app.devMode = true;
			logoTaps = [];
			toast.success("Dev-Modus aktiviert");
		}
	}

	async function handleShowFlyout() {
		try {
			await invoke("show_flyout");
		} catch (e) {
			toast.error(`Flyout-Fehler: ${errorText(e)}`, { duration: 60000 });
		}
	}
</script>

<div class="space-y-4">
	<SettingsCard title="Datenschutz" description="Was dein Gerät nie verlässt.">
		<div class="text-muted-foreground space-y-2 text-xs leading-relaxed">
			<p>
				Aktivitäten, Projekte, Notizen, Zeiten, Namen, E-Mail-Adressen, Dateien – nichts aus deinen
				Einträgen verlässt unverschlüsselt dein Gerät. Es gibt kein Tracking durch Fremdanbieter,
				und nichts geht an Dritte: alles bleibt auf deinem TimeTracker-Server.
			</p>
			{#if account.usagePingServer}
				<p>
					Einmal am Tag meldet die App anonym an <span class="text-foreground font-medium"
						>{account.usagePingServer}</span
					>, dass sie lief – mit Version und Betriebssystem, sonst nichts.
				</p>
			{/if}
		</div>
	</SettingsCard>

	<LogPanel />

	<SettingsCard
		title="TimeTracker"
		description="Zeiterfassung für Projektzeiten mit Monatsbericht."
	>
		<div class="flex items-center justify-between gap-3">
			<div class="flex items-center gap-3">
				<button type="button" class="cursor-none" onclick={handleTapLogo} aria-label="TimeTracker">
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
			<div class="flex items-center gap-2">
				{#if isTauri()}
					<Button variant="outline" size="sm" class="gap-1.5" onclick={() => whatsNew.open()}>
						<SparklesIcon class="size-3.5 text-primary" /> Neuerungen
					</Button>
				{/if}
				<Button variant="outline" size="sm" class="gap-1.5" onclick={() => openExternal(REPO_URL)}>
					<ExternalLinkIcon class="size-3.5" /> GitHub
				</Button>
			</div>
		</div>

		{#if app.devMode}
			<div>
				<div class="text-muted-foreground mb-2 text-xs font-medium">Dev</div>
				<div class="flex flex-wrap gap-2">
					<Button variant="secondary" size="sm" onclick={handleShowFlyout}>Tray-Flyout anzeigen</Button>
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
				<p class="text-muted-foreground mt-1.5 text-xs leading-relaxed">
					Beide durchlaufen den echten Startweg. An den erfassten Zeiten ändert sich nichts, ein
					laufender Timer zählt weiter.
				</p>
			</div>
		{/if}
	</SettingsCard>
</div>

