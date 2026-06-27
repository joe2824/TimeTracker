<script lang="ts">
	import { onMount } from "svelte";
	import { listen } from "@tauri-apps/api/event";
	import { invoke } from "@tauri-apps/api/core";
	import { enable, isEnabled } from "@tauri-apps/plugin-autostart";
	import { check } from "@tauri-apps/plugin-updater";
	import { toast } from "svelte-sonner";
	import { app } from "$lib/app.svelte";
	import { scheduleReminders } from "$lib/reminders";
	import { applyShortcuts } from "$lib/shortcuts";
	import { startWatchers, stopWatchers } from "$lib/watchers.svelte";
	import * as Tabs from "$lib/components/ui/tabs";
	import TimerIcon from "@lucide/svelte/icons/timer";
	import PencilLineIcon from "@lucide/svelte/icons/pencil-line";
	import ChartColumnIcon from "@lucide/svelte/icons/chart-column";
	import LayersIcon from "@lucide/svelte/icons/layers";
	import SettingsIcon from "@lucide/svelte/icons/settings";
	import TrackingPanel from "$lib/components/TrackingPanel.svelte";
	import EntryEditor from "$lib/components/EntryEditor.svelte";
	import ReportView from "$lib/components/ReportView.svelte";
	import ActivitiesPanel from "$lib/components/ActivitiesPanel.svelte";
	import SettingsPanel from "$lib/components/SettingsPanel.svelte";
	import IdleDialog from "$lib/components/IdleDialog.svelte";
	import CommandPalette from "$lib/components/CommandPalette.svelte";

	let tab = $state("tracking");
	let paletteOpen = $state(false);

	function onGlobalKey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
			e.preventDefault();
			paletteOpen = !paletteOpen;
		}
	}

	onMount(() => {
		const unlisteners: Array<() => void> = [];
		(async () => {
			await app.init();
			scheduleReminders();
			void applyShortcuts();
			startWatchers();

			// Autostart bei Login standardmaessig aktivieren (laeuft dann versteckt im Tray).
			if (app.settings.autostart) {
				try {
					if (!(await isEnabled())) await enable();
				} catch (e) {
					console.error("Autostart konnte nicht aktiviert werden", e);
				}
			}

			unlisteners.push(
				await listen("tray-stop-timer", () => void app.stop()),
				await listen<string>("tray-start-activity", (e) => void app.startActivity(e.payload))
			);

			// Beim Start still nach Updates suchen und ggf. Hinweis zeigen.
			try {
				const update = await check();
				if (update) {
					toast.info(`Update ${update.version} verfügbar`, {
						duration: 15000,
						action: { label: "Installieren", onClick: () => (tab = "settings") }
					});
				}
			} catch {
				/* offline o. Updater nicht konfiguriert – ignorieren */
			}
		})();
		return () => {
			unlisteners.forEach((u) => u());
			stopWatchers();
		};
	});

	// Tray-Menü (OneDrive-Stil) aktuell halten: laufender Timer + Schnellstart (Favoriten, zuletzt benutzt).
	$effect(() => {
		if (!app.loaded) return;

		const quick: { id: string; name: string; favorite: boolean }[] = [];
		const seen = new Set<string>();
		const push = (id: string, name: string, favorite: boolean) => {
			if (seen.has(id)) return;
			seen.add(id);
			quick.push({ id, name, favorite });
		};
		// Favoriten zuerst …
		for (const a of app.trackableActivities) if (a.favorite) push(a.id, a.name, true);
		// … dann zuletzt benutzte auffüllen.
		for (const a of app.recentActivities(6)) push(a.id, a.name, !!a.favorite);

		const running = app.running ? app.activityName(app.running.activityId) : null;
		void invoke("set_tray_state", { state: { running, activities: quick.slice(0, 6) } }).catch(
			() => {}
		);
	});
</script>

{#if !app.loaded}
	<div class="text-muted-foreground p-8">Lädt…</div>
{:else}
	<Tabs.Root bind:value={tab}>
		<header
			class="bg-background/80 supports-backdrop-filter:bg-background/60 sticky top-0 z-30 border-b backdrop-blur"
		>
			<div class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-2.5">
				<button
					type="button"
					onclick={() => (tab = "tracking")}
					class="shrink-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
					aria-label="Startseite"
				>
					<img src="/logo.svg" alt="TimeTracker" class="h-12 w-auto transition-transform hover:scale-105" />
				</button>

				<Tabs.List variant="line" class="gap-2">
					<Tabs.Trigger value="tracking"><TimerIcon />Tracking</Tabs.Trigger>
					<Tabs.Trigger value="entries"><PencilLineIcon />Einträge</Tabs.Trigger>
					<Tabs.Trigger value="report"><ChartColumnIcon />Bericht</Tabs.Trigger>
					<Tabs.Trigger value="activities"><LayersIcon />Aktivitäten</Tabs.Trigger>
					<Tabs.Trigger value="settings"><SettingsIcon />Einstellungen</Tabs.Trigger>
				</Tabs.List>

				{#if app.running}
					<span
						class="border-primary/20 bg-primary/10 text-primary ml-auto inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium"
					>
						<span class="relative flex size-2">
							<span
								class="bg-primary absolute inline-flex size-full animate-ping rounded-full opacity-75"
							></span>
							<span class="bg-primary relative inline-flex size-2 rounded-full"></span>
						</span>
						{app.activityName(app.running.activityId)}
					</span>
				{/if}
			</div>
		</header>

		<div class="mx-auto w-full max-w-6xl px-6 py-4">
			<Tabs.Content value="tracking" class="mt-0">
				<TrackingPanel />
			</Tabs.Content>
			<Tabs.Content value="entries" class="mt-4">
				<EntryEditor />
			</Tabs.Content>
			<Tabs.Content value="report" class="mt-4">
				<ReportView />
			</Tabs.Content>
			<Tabs.Content value="activities" class="mt-4">
				<ActivitiesPanel />
			</Tabs.Content>
			<Tabs.Content value="settings" class="mt-4">
				<SettingsPanel />
			</Tabs.Content>
		</div>
	</Tabs.Root>

	<IdleDialog />
	<CommandPalette bind:open={paletteOpen} onNavigate={(t) => (tab = t)} />
{/if}

<svelte:window onkeydown={onGlobalKey} />
