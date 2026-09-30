<script lang="ts">
	import { onMount } from "svelte";
	import { app } from "$lib/app.svelte";
	import { errorText, logError, logInfo } from "$lib/log";
	import { fmtHMS } from "$lib/time/time";
	import { START_PRESETS } from "$lib/time/startTime";
	import { startPicker as picker } from "$lib/ui/startPicker.svelte";
	import { keepTrayInSync } from "$lib/ui/trayState.svelte";
	import { Button } from "$lib/components/ui/button";
	import * as ButtonGroup from "$lib/components/ui/button-group";
	import { Input } from "$lib/components/ui/input";
	import BackdateDialog from "$lib/components/dialogs/BackdateDialog.svelte";
	import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
	import { invoke } from "@tauri-apps/api/core";
	import { emit, listen } from "@tauri-apps/api/event";
	import { notifyDataChanged, type DataChanged } from "$lib/platform/windows";
	import SquareIcon from "@lucide/svelte/icons/square";
	import PlayIcon from "@lucide/svelte/icons/play";
	import StarIcon from "@lucide/svelte/icons/star";
	import XIcon from "@lucide/svelte/icons/x";
	import ClockIcon from "@lucide/svelte/icons/clock";
	import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
	import ActivityDot from "$lib/components/shared/ActivityDot.svelte";
	import { account } from "$lib/sync/account.svelte";

	const win = getCurrentWebviewWindow();

	// Schnellstart: Favoriten zuerst, dann zuletzt benutzte (Regel: app.quickActivities).
	const quick = $derived(app.quickActivities(8));

	// Offene Benachrichtigung im Hauptfenster? -> Hinweis-Badge an „App öffnen".
	let attention = $state(false);

	// Lesefehler benennen: sonst zeigte das Flyout nur eine leere Schnellstart-Liste
	// und sah aus wie „keine Aktivitäten", obwohl die Daten nur nicht lesbar waren.
	let loadError = $state<string | null>(null);

	async function refresh() {
		// Erst den Haken, dann laden: reload() repariert eingebaute Zeilen, und
		// das soll vorgemerkt werden. Jedes Mal, siehe account.initWriter.
		await account.initWriter().catch((e) => logError("Flyout: Vormerken nicht eingeschaltet", e));
		try {
			await app.reload();
			loadError = null;
		} catch (e) {
			logError("Flyout konnte die Daten nicht laden", e);
			loadError = errorText(e);
		}
		// Aktuellen Hinweis-Status beim Hauptfenster anfragen (Antwort via "main-attention").
		void emit("tray-request-attention").catch(() => {});
	}

	/** Abgleichen lässt das Hauptfenster – siehe account.initWriter. */
	function requestSync() {
		void emit("tray-sync-request").catch(() => {});
	}

	onMount(() => {
		logInfo("Tray-Flyout geöffnet");
		void refresh().then(requestSync);
		// Eigener Tick (dieses Fenster ruft app.init() nicht auf) für die Live-Anzeige.
		const tick = setInterval(() => (app.now = Date.now()), 1000);
		// Bei jedem Einblenden (Fokus oder Tray-Klick) frische Daten laden.
		const unFocus = win.onFocusChanged(({ payload }) => {
			if (payload) {
				void refresh();
				requestSync();
			}
		});
		const unShown = listen("tray-shown", () => {
			void refresh();
			requestSync();
		});
		const unAttention = listen<{ active: boolean }>(
			"main-attention",
			(e) => (attention = !!e.payload?.active)
		);
		// Das Hauptfenster meldet, wenn der Abgleich etwas mitgebracht hat oder Daten geändert wurden.
		const unData = listen<DataChanged>("data-reload", (e) => {
			if (e.payload?.from === "tray") return;
			void refresh();
		});
		return () => {
			clearInterval(tick);
			void unFocus.then((f) => f());
			void unShown.then((f) => f());
			void unAttention.then((f) => f());
			void unData.then((f) => f());
		};
	});

	keepTrayInSync();

	let clockInput = $state<HTMLInputElement | null>(null);

	async function start(id: string) {
		// Rückfrage offen? Dann ist nichts gestartet – erst der Dialog meldet
		// (onapplied unten). Sonst hätte das Hauptfenster einen Zustand geladen,
		// in dem gar nichts passiert ist, und den späteren Start nie erfahren.
		if (!(await picker.start(id))) return;
		await notifyDataChanged({ from: "tray" }); // Hauptfenster aktualisieren + Tray-Menü/Icon
		// Flyout bleibt offen; schließt erst bei Fokusverlust.
	}
	async function stop() {
		await app.stop();
		await notifyDataChanged({ from: "tray" });
	}
	async function openMain() {
		// Derselbe Weg wie „Öffnen" im Tray-Menü (show_main im Rust-Teil), statt
		// das Fenster hier ein zweites Mal von Hand hervorzuholen.
		await invoke("show_main_window");
		await win.hide();
	}
</script>

<div class="bg-background text-foreground flex h-dvh flex-col gap-2.5 px-2.5 py-3 text-sm">
	<!-- Statusbereich mit fester (schlanker) Höhe: hält die Schnellstart-Liste an
	     Ort und Stelle, egal ob ein Timer läuft oder nicht. -->
	<div class="flex h-16 shrink-0 flex-col gap-1">
		{#if app.running}
			<div
				class="border-primary/20 bg-primary/10 flex flex-1 items-center justify-between gap-2 rounded-lg border px-3 py-1.5"
			>
				<div class="min-w-0">
					<div class="flex items-center gap-1.5">
						<!-- Derselbe pulsierende Punkt wie in Kopfzeile und Hauptfenster. -->
						<span class="relative flex size-1.5 shrink-0">
							<span
								class="bg-primary absolute inline-flex size-full animate-ping rounded-full opacity-75"
							></span>
							<span class="bg-primary relative inline-flex size-1.5 rounded-full"></span>
						</span>
						<span class="truncate text-xs font-medium">
							{app.activityName(app.running.activityId)}
						</span>
					</div>
					<div class="text-primary font-mono text-base leading-tight tabular-nums">
						{fmtHMS(app.runningSeconds)}
					</div>
				</div>
				<Button variant="destructive" size="sm" onclick={stop}>
					<SquareIcon class="size-4" /> Stopp
				</Button>
			</div>
		{:else}
			<!-- Der Hinweis nimmt den Platz der Überschrift ein, statt eine Zeile
			     zu ergänzen: der Statusbereich hat feste Höhe, damit die Liste
			     darunter nicht springt. Sobald eine Startzeit gewählt ist, sagt
			     der Hinweis ohnehin mehr als "Timer starten". -->
			<div
				class="text-muted-foreground line-clamp-2 text-center text-[11px] leading-tight"
				title={picker.hint ?? undefined}
			>
				{picker.hint ?? "Timer starten"}
			</div>
			<!-- 300px Flyout: xs-Grösse, und das Uhrzeitfeld erscheint erst, wenn es
			     gebraucht wird. Die gewählte Option ist hervorgehoben. -->
			<div class="flex flex-1 items-center justify-center gap-1">
				{#if picker.usingClock}
					<Input
						bind:ref={clockInput}
						type="time"
						bind:value={picker.customStart}
						class="h-6 w-20 shrink-0 px-1 text-xs"
						oninput={() => (picker.presetMin = 0)}
					/>
					<Button variant="ghost" size="icon-xs" title="Uhrzeit verwerfen" onclick={() => (picker.customStart = "")}>
						<XIcon />
					</Button>
				{:else}
					<ButtonGroup.Root>
						<Button
							variant={picker.presetMin === 0 ? "default" : "outline"}
							size="xs"
							onclick={() => picker.choosePreset(0)}
						>
							Jetzt
						</Button>
						{#each START_PRESETS as m (m)}
							<Button
								variant={picker.presetMin === m ? "default" : "outline"}
								size="xs"
								onclick={() => picker.choosePreset(m)}
							>
								−{m}
							</Button>
						{/each}
						<Button
							variant="outline"
							size="icon-xs"
							title="Ab einer bestimmten Uhrzeit"
							onclick={() => {
								picker.chooseClock();
								clockInput?.focus();
							}}
						>
							<ClockIcon />
						</Button>
					</ButtonGroup.Root>
				{/if}
			</div>
		{/if}
	</div>

	<div class="text-muted-foreground px-0.5 text-xs font-medium">Schnellstart</div>
	{#if loadError}
		<p class="text-destructive px-2 text-xs">Daten nicht lesbar: {loadError}</p>
	{/if}
	<!-- Scrollbalken kommt global aus app.css (dünn, dezent). -->
	<div class="flex-1 space-y-1 overflow-y-auto">
		{#each quick as a (a.id)}
			{@const active = app.running?.activityId === a.id}
			<button
				type="button"
				class="hover:bg-accent focus-visible:ring-ring/50 flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-3 {active
					? 'bg-accent'
					: ''}"
				onclick={() => (active ? stop() : start(a.id))}
			>
				{#if active}
					<SquareIcon class="size-4 shrink-0" />
				{:else}
					<PlayIcon class="size-4 shrink-0" />
				{/if}
				<ActivityDot color={a.color} />
				<span class="flex-1 truncate">{a.name}</span>
				{#if a.favorite}
					<StarIcon class="size-3.5 shrink-0 fill-yellow-400 text-yellow-400" />
				{/if}
			</button>
		{:else}
			<p class="text-muted-foreground px-2 text-xs">Keine Aktivitäten.</p>
		{/each}
	</div>

	<div class="relative">
		<Button
			variant="outline"
			size="sm"
			class="w-full {attention ? 'border-amber-500/60 text-amber-600 dark:text-amber-400' : ''}"
			onclick={openMain}
		>
			<ExternalLinkIcon class="size-4" />
			{attention ? "Neue Meldung – öffnen" : "App öffnen"}
		</Button>
		{#if attention}
			<span
				class="pointer-events-none absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center"
			>
				<span class="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-75"
				></span>
				<span
					class="relative inline-flex size-4 items-center justify-center rounded-full bg-amber-500 text-[10px] leading-none font-bold text-white"
				>
					!
				</span>
			</span>
		{/if}
	</div>
</div>

<BackdateDialog
	onapplied={() => {
		picker.reset();
		void notifyDataChanged();
	}}
/>
