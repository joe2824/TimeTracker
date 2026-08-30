<script lang="ts">
	import { onMount } from "svelte";
	import { app } from "$lib/app.svelte";
	import { errorText, logError, logInfo } from "$lib/log";
	import { fmtClock, fmtHMS, midnightSplitHint } from "$lib/time";
	import { START_PRESETS, resolveStartTs, toStartArg } from "$lib/startTime";
	import { Button } from "$lib/components/ui/button";
	import * as ButtonGroup from "$lib/components/ui/button-group";
	import { Input } from "$lib/components/ui/input";
	import BackdateDialog from "$lib/components/dialogs/BackdateDialog.svelte";
	import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
	import { invoke } from "@tauri-apps/api/core";
	import { emit, listen } from "@tauri-apps/api/event";
	import { notifyDataChanged, type DataChanged } from "$lib/platform/windows";
	import { toast } from "svelte-sonner";
	import SquareIcon from "@lucide/svelte/icons/square";
	import PlayIcon from "@lucide/svelte/icons/play";
	import StarIcon from "@lucide/svelte/icons/star";
	import XIcon from "@lucide/svelte/icons/x";
	import ClockIcon from "@lucide/svelte/icons/clock";
	import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
	import ActivityDot from "$lib/components/shared/ActivityDot.svelte";

	const win = getCurrentWebviewWindow();

	// Schnellstart: Favoriten zuerst, dann zuletzt benutzte (Regel: app.quickActivities).
	const quick = $derived(app.quickActivities(8));

	// Offene Benachrichtigung im Hauptfenster? -> Hinweis-Badge an „App öffnen".
	let attention = $state(false);

	// Lesefehler benennen: sonst zeigte das Flyout nur eine leere Schnellstart-Liste
	// und sah aus wie „keine Aktivitaeten", obwohl die Daten nur nicht lesbar waren.
	let loadError = $state<string | null>(null);

	async function refresh() {
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

	onMount(() => {
		logInfo("Tray-Flyout geöffnet");
		void refresh();
		// Eigener Tick (dieses Fenster ruft app.init() nicht auf) für die Live-Anzeige.
		const tick = setInterval(() => (app.now = Date.now()), 1000);
		// Bei jedem Einblenden (Fokus oder Tray-Klick) frische Daten laden.
		const un = win.onFocusChanged(({ payload }) => {
			if (payload) void refresh();
		});
		const unShown = listen("tray-shown", () => {
			void refresh();
		});
		const unAtt = listen<{ active: boolean }>(
			"main-attention",
			(e) => (attention = !!e.payload?.active)
		);
		// Das Hauptfenster meldet, wenn der Abgleich etwas mitgebracht hat oder Daten geändert wurden.
		const unDaten = listen<DataChanged>("data-reload", (e) => {
			if (e.payload?.from === "tray") return;
			void refresh();
		});
		return () => {
			clearInterval(tick);
			void un.then((f) => f());
			void unShown.then((f) => f());
			void unAtt.then((f) => f());
			void unDaten.then((f) => f());
		};
	});

	// Tray-Icon und Menü immer aktuell halten, auch wenn das Hauptfenster geschlossen ist.
	$effect(() => {
		if (!app.loaded) return;
		const quick = app
			.quickActivities(6)
			.map((a) => ({ id: a.id, name: a.name, favorite: !!a.favorite }));
		const running = app.running ? app.activityName(app.running.activityId) : null;
		void invoke("set_tray_state", { state: { running, activities: quick } }).catch(() => {});
	});

	// Startzeit-Auswahl (analog zum Hauptfenster): Preset "vor X min" (0 = jetzt)
	// oder freie Uhrzeit. Nützlich, wenn man den Timer verspätet startet.
	let presetMin = $state(0);
	let customStart = $state("");
	let clockInput = $state<HTMLInputElement | null>(null);
	/** Gilt gerade die freie Uhrzeit? Steuert Anzeige UND Auswertung. */
	const usingClock = $derived(customStart !== "");

	const startHint = $derived.by(() => {
		const now = app.now;
		if (!customStart && presetMin === 0) return null;
		const ts = resolveStartTs(presetMin, customStart);
		if (ts == null) return "ungültige Uhrzeit";
		// Auch im Tray sagen, dass zwei Eintraege entstehen - hier wird genauso rueckdatiert.
		const geteilt = midnightSplitHint(ts, now);
		return geteilt ? `ab ${fmtClock(ts)} – ${geteilt}` : `ab ${fmtClock(ts)}`;
	});

	async function start(id: string) {
		const now = Date.now();
		const ts = resolveStartTs(presetMin, customStart, now);
		if (ts == null) {
			toast.error("Unlesbare Startzeit.");
			return;
		}
		await app.startActivity(id, toStartArg(ts, now));
		// Rueckfrage offen? Dann ist nichts gestartet – erst der Dialog meldet
		// (onapplied unten). Sonst haette das Hauptfenster einen Zustand geladen,
		// in dem gar nichts passiert ist, und den spaeteren Start nie erfahren.
		if (app.backdatePrompt) return;
		// Nach dem Start zurück auf "jetzt", damit der Offset nicht am nächsten Start klebt.
		presetMin = 0;
		customStart = "";
		await notifyDataChanged(); // Hauptfenster aktualisieren + Tray-Menü/Icon
		// Flyout bleibt offen; schließt erst bei Fokusverlust.
	}
	async function stop() {
		await app.stop();
		await notifyDataChanged();
	}
	async function openMain() {
		// Derselbe Weg wie „Öffnen" im Tray-Menue (show_main im Rust-Teil), statt
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
			<!-- Der Hinweis nimmt den Platz der Ueberschrift ein, statt eine Zeile
			     zu ergaenzen: der Statusbereich hat feste Hoehe, damit die Liste
			     darunter nicht springt. Sobald eine Startzeit gewaehlt ist, sagt
			     der Hinweis ohnehin mehr als "Timer starten". -->
			<div
				class="text-muted-foreground line-clamp-2 text-center text-[11px] leading-tight"
				title={startHint ?? undefined}
			>
				{startHint ?? "Timer starten"}
			</div>
			<!-- 300px Flyout: xs-Groesse, und das Uhrzeitfeld erscheint erst, wenn es
			     gebraucht wird. Die gewaehlte Option ist hervorgehoben. -->
			<div class="flex flex-1 items-center justify-center gap-1">
				{#if usingClock}
					<Input
						bind:ref={clockInput}
						type="time"
						bind:value={customStart}
						class="h-6 w-20 shrink-0 px-1 text-xs"
						oninput={() => (presetMin = 0)}
					/>
					<Button variant="ghost" size="icon-xs" title="Uhrzeit verwerfen" onclick={() => (customStart = "")}>
						<XIcon />
					</Button>
				{:else}
					<ButtonGroup.Root>
						<Button
							variant={presetMin === 0 ? "default" : "outline"}
							size="xs"
							onclick={() => (presetMin = 0)}
						>
							Jetzt
						</Button>
						{#each START_PRESETS as m (m)}
							<Button
								variant={presetMin === m ? "default" : "outline"}
								size="xs"
								onclick={() => (presetMin = m)}
							>
								−{m}
							</Button>
						{/each}
						<Button
							variant="outline"
							size="icon-xs"
							title="Ab einer bestimmten Uhrzeit"
							onclick={() => {
								customStart = fmtClock(Date.now());
								presetMin = 0;
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
		presetMin = 0;
		customStart = "";
		void notifyDataChanged();
	}}
/>
