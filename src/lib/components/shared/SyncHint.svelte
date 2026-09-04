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
	/** Ein Schwung Daten, auf den jemand wartet - nicht die Historie nebenher. */
	const isBulkPull = $derived(
		account.phase === "running" &&
			(account.syncProgress?.pulled ?? 0) >= 20 &&
			!account.syncProgress?.background
	);

	interface Status {
		tone: string;
		text: string;
		titleText: string;
		/** Laeuft gerade etwas? Dann dreht sich das Icon statt des Punktes. */
		busy?: boolean;
	}

	const statusInfo = $derived.by((): Status | null => {
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
				busy: true,
				text: "Daten werden geladen …",
				titleText: `${account.syncProgress?.pulled ?? 0} Einträge vom Server geladen`
			};
		}
		// Die Historie laeuft nebenher weiter. Sie steht hier, weil daran die
		// gesperrte Sicherung haengt - aber leise, es wartet niemand darauf.
		if (account.backfilling) {
			return {
				tone: "bg-emerald-500",
				busy: true,
				text: "Ältere Monate …",
				titleText: account.historyIncomplete
					? "Ältere Monate kommen im Hintergrund nach. Du kannst schon arbeiten; Sicherungen gehen erst danach wieder."
					: "Ältere Monate werden im Hintergrund aufgefrischt."
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

	const spinning = $derived(statusInfo?.busy === true);
</script>

<!--
	Feste Breite, rechts ausgerichtet.

	Der Text wechselt bei jedem Abgleich: "vor 3 Min" -> "" (der Stand ist wieder
	frisch) -> "Daten werden geladen …" -> "". Ohne den festen Platz aendert sich
	dabei die Breite dieser Zeile, und weil die Kopfzeile rechtsbuendig steht,
	wandert alles daneben kurz mit - bei jedem Abgleich, im Browser wie in der
	Anwendung.
-->
{#if statusInfo}
	<span
		class="text-muted-foreground inline-flex w-24 shrink-0 items-center justify-end gap-1.5 overflow-hidden text-xs whitespace-nowrap sm:w-36"
		title={statusInfo.titleText}
	>
		{#if spinning}
			<RefreshCwIcon class="size-3 shrink-0 animate-spin opacity-70" />
			<span class="truncate">{statusInfo.text}</span>
		{:else}
			<span
				class="size-1.5 shrink-0 rounded-full {statusInfo.tone} {account.phase === 'running' ? 'animate-pulse ring-2 ring-emerald-500/30' : ''}"
			></span>
			{#if statusInfo.text}<span class="truncate">{statusInfo.text}</span>{/if}
		{/if}
	</span>
{/if}
