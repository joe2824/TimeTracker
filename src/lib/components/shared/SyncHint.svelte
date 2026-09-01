<script lang="ts">
	// Wie frisch der Stand ist - klein, in der Kopfzeile.
	import { account } from "$lib/sync/account.svelte";
	import { app } from "$lib/app.svelte";
	import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";

	/** Bis hierhin gilt der Stand als frisch - dann genuegt der Punkt. */
	const FRESH_MS = 60_000;

	/** "vor 3 Min" - grob genug, dass es nicht jede Sekunde flackert. */
	function howLongAgo(ms: number): string {
		const sec = Math.floor(ms / 1000);
		if (sec < 60) return `vor ${sec} Sek`;
		const min = Math.floor(sec / 60);
		if (min < 60) return `vor ${min} Min`;
		const std = Math.floor(min / 60);
		if (std < 24) return `vor ${std} Std`;
		return `vor ${Math.floor(std / 24)} Tg`;
	}

	const age = $derived(account.lastSync ? app.now - account.lastSync : null);
	const isBulkPull = $derived(account.phase === "running" && (account.syncProgress?.pulled ?? 0) >= 20);

	const statusInfo = $derived.by(() => {
		if (!account.linked) return null;
		if (account.state === "error") {
			return { tone: "bg-destructive", text: "Getrennt", titleText: account.message };
		}
		if (account.phase === "error" || account.phase === "offline") {
			return {
				tone: "bg-amber-500",
				text: age === null ? "Offline" : `Offline · ${howLongAgo(age)}`,
				titleText: "Keine Verbindung zum Server – Änderungen warten hier."
			};
		}
		if (isBulkPull) {
			return {
				tone: "bg-blue-500",
				text: `Lade Daten… (${account.syncProgress!.pulled})`,
				titleText: "Synchronisiere Daten mit dem Server…"
			};
		}
		return {
			tone: "bg-emerald-500",
			// Erst wenn es eine Weile her ist, ist die Zahl eine Information.
			text: age !== null && age >= FRESH_MS ? howLongAgo(age) : "",
			titleText:
				account.phase === "running"
					? "Synchronisiere…"
					: age === null
						? "Mit dem Server verbunden"
						: `Letzter Abgleich ${howLongAgo(age)}`
		};
	});
</script>

{#if statusInfo}
	<span
		class="text-muted-foreground inline-flex items-center gap-1.5 text-xs whitespace-nowrap"
		title={statusInfo.titleText}
	>
		{#if isBulkPull}
			<RefreshCwIcon class="size-3 text-primary animate-spin shrink-0" />
			<span class="text-primary font-medium">{statusInfo.text}</span>
		{:else}
			<span
				class="size-1.5 shrink-0 rounded-full {statusInfo.tone} {account.phase === 'running' ? 'animate-pulse ring-2 ring-emerald-500/30' : ''}"
			></span>
			{#if statusInfo.text}{statusInfo.text}{/if}
		{/if}
	</span>
{/if}
