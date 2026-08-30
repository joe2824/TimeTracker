<script lang="ts">
	// Wie frisch der Stand ist - klein, in der Kopfzeile.
	import { account } from "$lib/sync/account.svelte";
	import { app } from "$lib/app.svelte";

	/** Bis hierhin gilt der Stand als frisch - dann genuegt der Punkt. */
	const FRISCH_MS = 60_000;

	/** "vor 3 Min" - grob genug, dass es nicht jede Sekunde flackert. */
	function vorWieLange(ms: number): string {
		const sek = Math.floor(ms / 1000);
		if (sek < 60) return `vor ${sek} Sek`;
		const min = Math.floor(sek / 60);
		if (min < 60) return `vor ${min} Min`;
		const std = Math.floor(min / 60);
		if (std < 24) return `vor ${std} Std`;
		return `vor ${Math.floor(std / 24)} Tg`;
	}

	const alter = $derived(account.lastSync ? app.now - account.lastSync : null);

	/**
	 * Punkt und - nur wenn noetig - ein Text. Im Normalfall bleibt der Punkt
	 * allein: dass gerade abgeglichen wurde, sieht man daran, dass er gruen ist.
	 */
	const zustand = $derived.by(() => {
		if (!account.linked) return null;
		if (account.state === "fehler") {
			return { ton: "bg-destructive", text: "Getrennt", titel: account.message };
		}
		if (account.phase === "fehler" || account.phase === "offline") {
			return {
				ton: "bg-amber-500",
				text: alter === null ? "Offline" : `Offline · ${vorWieLange(alter)}`,
				titel: "Keine Verbindung zum Server – Änderungen warten hier."
			};
		}
		return {
			ton: "bg-emerald-500",
			// Erst wenn es eine Weile her ist, ist die Zahl eine Information.
			text: alter !== null && alter >= FRISCH_MS ? vorWieLange(alter) : "",
			titel:
				alter === null
					? "Mit dem Server verbunden"
					: `Letzter Abgleich ${vorWieLange(alter)}`
		};
	});
</script>

{#if zustand}
	<span
		class="text-muted-foreground inline-flex items-center gap-1.5 text-xs whitespace-nowrap"
		title={zustand.titel}
	>
		<span class="size-1.5 shrink-0 rounded-full {zustand.ton}"></span>
		{#if zustand.text}{zustand.text}{/if}
	</span>
{/if}
