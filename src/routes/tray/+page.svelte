<script lang="ts">
	import { onMount } from "svelte";
	import { app } from "$lib/app.svelte";
	import { fmtClock, fmtHMS } from "$lib/time";
	import { START_PRESETS, resolveStartTs, toStartArg } from "$lib/startTime";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
	import { emit, listen } from "@tauri-apps/api/event";
	import { toast } from "svelte-sonner";
	import SquareIcon from "@lucide/svelte/icons/square";
	import PlayIcon from "@lucide/svelte/icons/play";
	import StarIcon from "@lucide/svelte/icons/star";
	import ExternalLinkIcon from "@lucide/svelte/icons/external-link";

	const win = getCurrentWebviewWindow();

	// Schnellstart: Favoriten zuerst, dann zuletzt benutzte.
	const quick = $derived.by(() => {
		const out: { id: string; name: string; color?: string; favorite: boolean }[] = [];
		const seen = new Set<string>();
		const push = (a: { id: string; name: string; color?: string; favorite?: boolean }) => {
			if (seen.has(a.id)) return;
			seen.add(a.id);
			out.push({ id: a.id, name: a.name, color: a.color, favorite: !!a.favorite });
		};
		for (const a of app.trackableActivities) if (a.favorite) push(a);
		for (const a of app.recentActivities(8)) push(a);
		return out.slice(0, 8);
	});

	// Offene Benachrichtigung im Hauptfenster? -> Hinweis-Badge an „App öffnen".
	let attention = $state(false);

	async function refresh() {
		await app.reload();
		// Aktuellen Hinweis-Status beim Hauptfenster anfragen (Antwort via "main-attention").
		void emit("tray-request-attention").catch(() => {});
	}

	onMount(() => {
		void refresh();
		// Eigener Tick (dieses Fenster ruft app.init() nicht auf) für die Live-Anzeige.
		const tick = setInterval(() => (app.now = Date.now()), 1000);
		// Bei jedem Einblenden (Fokus) frische Daten laden.
		const un = win.onFocusChanged(({ payload }) => {
			if (payload) void refresh();
		});
		const unAtt = listen<{ active: boolean }>(
			"main-attention",
			(e) => (attention = !!e.payload?.active)
		);
		return () => {
			clearInterval(tick);
			void un.then((f) => f());
			void unAtt.then((f) => f());
		};
	});

	// Startzeit-Auswahl (analog zum Hauptfenster): Preset "vor X min" (0 = jetzt)
	// oder freie Uhrzeit. Nützlich, wenn man den Timer verspätet startet.
	let presetMin = $state(0);
	let customStart = $state("");

	const startHint = $derived.by(() => {
		void app.now;
		if (!customStart && presetMin === 0) return null;
		const ts = resolveStartTs(presetMin, customStart);
		return ts == null ? "ungültige Uhrzeit" : `ab ${fmtClock(ts)}`;
	});

	async function start(id: string) {
		const now = Date.now();
		const ts = resolveStartTs(presetMin, customStart, now);
		if (ts == null) {
			toast.error("Ungültige Startzeit (liegt in der Zukunft?).");
			return;
		}
		await app.startActivity(id, toStartArg(ts, now));
		// Nach dem Start zurück auf "jetzt", damit der Offset nicht am nächsten Start klebt.
		presetMin = 0;
		customStart = "";
		await emit("data-reload"); // Hauptfenster aktualisieren + Tray-Menü/Icon
		// Flyout bleibt offen; schließt erst bei Fokusverlust.
	}
	async function stop() {
		await app.stop();
		await emit("data-reload");
	}
	async function openMain() {
		const main = await WebviewWindow.getByLabel("main");
		await main?.show();
		await main?.unminimize();
		await main?.setFocus();
		await win.hide();
	}
</script>

<div class="bg-background text-foreground flex h-screen flex-col gap-3 px-2 py-3 text-sm">
	<!-- Statusbereich mit fester (schlanker) Höhe: hält die Schnellstart-Liste an
	     Ort und Stelle, egal ob ein Timer läuft oder nicht. -->
	<div class="flex h-16 shrink-0 flex-col gap-1">
		{#if app.running}
			<div class="border-primary/20 bg-primary/10 flex flex-1 items-center justify-between gap-2 rounded-lg border px-3 py-1.5">
				<div class="min-w-0">
					<div class="truncate text-xs font-medium">{app.activityName(app.running.activityId)}</div>
					<div class="text-primary font-mono text-base tabular-nums">{fmtHMS(app.runningSeconds)}</div>
				</div>
				<Button variant="destructive" size="sm" onclick={stop}>
					<SquareIcon class="size-4" /> Stopp
				</Button>
			</div>
		{:else}
			<div class="text-muted-foreground text-center text-[11px] leading-none">Timer starten</div>
			<div class="flex flex-1 flex-nowrap items-center gap-1 rounded-md border px-1.5 text-xs">
				<button
					type="button"
					class="hover:bg-accent shrink-0 rounded px-1.5 py-0.5 {presetMin === 0 && !customStart
						? 'bg-accent font-medium'
						: ''}"
					onclick={() => {
						presetMin = 0;
						customStart = "";
					}}
				>
					Jetzt
				</button>
				{#each START_PRESETS as m (m)}
					<button
						type="button"
						class="hover:bg-accent shrink-0 rounded px-1 py-0.5 {presetMin === m && !customStart
							? 'bg-accent font-medium'
							: ''}"
						onclick={() => {
							presetMin = m;
							customStart = "";
						}}
					>
						−{m}
					</button>
				{/each}
				<Input
					type="time"
					bind:value={customStart}
					class="h-6 w-18 shrink-0 px-1 text-xs"
					oninput={() => (presetMin = 0)}
				/>
			</div>
		{/if}
	</div>

	<div class="text-muted-foreground text-xs font-medium">Schnellstart</div>
	<!-- Scrollbalken kommt global aus app.css (dünn, dezent). -->
	<div class="flex-1 space-y-1 overflow-y-auto">
		{#each quick as a (a.id)}
			{@const active = app.running?.activityId === a.id}
			<button
				type="button"
				class="hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left {active
					? 'bg-accent'
					: ''}"
				onclick={() => (active ? stop() : start(a.id))}
			>
				{#if active}
					<SquareIcon class="size-4 shrink-0" />
				{:else}
					<PlayIcon class="size-4 shrink-0" />
				{/if}
				{#if a.color}
					<span class="size-2.5 shrink-0 rounded-full" style={`background:${a.color}`}></span>
				{/if}
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
