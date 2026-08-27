<script lang="ts">
	import { KEEP_DAYS, LOG_DIR, clearLogs, errorText, logFile, readLog } from "$lib/log";
	import { Button } from "$lib/components/ui/button";
	import * as Card from "$lib/components/ui/card";
	import { appDataDir, join } from "@tauri-apps/api/path";
	import { revealInFolder } from "$lib/platform/open";
	import { toast } from "svelte-sonner";
	import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
	import FolderOpenIcon from "@lucide/svelte/icons/folder-open";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";
	import { isTauri } from "$lib/platform/env";

	/** Mehr als das liest ohnehin niemand am Bildschirm; die Datei hat alles. */
	const SHOWN_LINES = 200;

	let lines = $state<string[]>([]);
	let loading = $state(false);
	/** Nur Warnungen und Fehler – der uebliche Blick bei „irgendwas stimmt nicht". */
	let onlyProblems = $state(false);

	const shown = $derived(onlyProblems ? problems(lines) : lines);

	/**
	 * Warnungen und Fehler – mitsamt ihren eingerueckten Fortsetzungszeilen.
	 * Ein Fehler ohne seine Aufrufliste ist genau die Haelfte, die nicht hilft.
	 */
	function problems(all: string[]): string[] {
		const out: string[] = [];
		let keep = false;
		for (const line of all) {
			if (line.startsWith("\t")) {
				if (keep) out.push(line);
				continue;
			}
			keep = / (WARN|ERROR) /.test(line);
			if (keep) out.push(line);
		}
		return out;
	}

	async function refresh() {
		loading = true;
		try {
			lines = await readLog(SHOWN_LINES);
		} catch (e) {
			toast.error(`Protokoll nicht lesbar: ${errorText(e)}`);
		} finally {
			loading = false;
		}
	}

	let visibleMarker = $state<HTMLElement | null>(null);

	/** Lesen, sobald die Karte tatsaechlich zu sehen ist. */
	$effect(() => {
		if (!visibleMarker) return;
		const io = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting)) void refresh();
		});
		io.observe(visibleMarker);
		return () => io.disconnect();
	});

	async function openFolder() {
		try {
			// Auf die heutige Datei zeigen: der Explorer oeffnet dann den Ordner und
			// markiert sie. Auf den Ordner selbst gezeigt landete man eine Ebene zu hoch.
			await revealInFolder(await join(await appDataDir(), logFile()));
		} catch (e) {
			toast.error(`Ordner nicht zu öffnen: ${errorText(e)}`, { duration: 30000 });
		}
	}

	async function clearAll() {
		try {
			const n = await clearLogs();
			await refresh();
			toast.success(`${n} Protokolldatei${n === 1 ? "" : "en"} gelöscht.`);
		} catch (e) {
			toast.error(`Löschen fehlgeschlagen: ${errorText(e)}`);
		}
	}
</script>

<Card.Root class="lg:col-span-2">
	<Card.Header>
		<Card.Title>Protokoll</Card.Title>
		<Card.Description>
			Für die Fehlersuche: Ereignisse und Fehler, eine Datei je Tag, {KEEP_DAYS} Tage lang.
			{#if isTauri()}
				Sie liegen unter <code class="text-xs">{LOG_DIR}/</code> im App-Datenordner – bei einem
				Problem hilft es, die Datei mitzuschicken.
			{:else}
				Im Browser liegen sie in dessen eigener Ablage; zum Mitschicken den Text hier unten
				kopieren.
			{/if}
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-3">
		<div class="flex flex-wrap gap-2" bind:this={visibleMarker}>
			<Button variant="outline" size="sm" onclick={refresh} disabled={loading}>
				<RefreshCwIcon class="size-4" />
				{loading ? "Liest…" : "Aktualisieren"}
			</Button>
			<Button
				variant={onlyProblems ? "default" : "outline"}
				size="sm"
				onclick={() => (onlyProblems = !onlyProblems)}
			>
				Nur Warnungen & Fehler
			</Button>
			{#if isTauri()}
				<!-- Im Browser gibt es keinen Ordner: das Protokoll liegt in der
				     Ablage des Browsers, nicht als Datei. -->
				<Button variant="outline" size="sm" onclick={openFolder}>
					<FolderOpenIcon class="size-4" /> Ordner öffnen
				</Button>
			{/if}
			<Button variant="outline" size="sm" onclick={clearAll}>
				<Trash2Icon class="size-4" /> Leeren
			</Button>
		</div>

		{#if shown.length === 0}
			<p class="text-muted-foreground text-sm">
				{onlyProblems ? "Keine Warnungen oder Fehler." : "Noch nichts protokolliert."}
			</p>
		{:else}
			<!-- Neueste unten, wie in jeder Logdatei; der Kasten scrollt selbst, damit
			     lange Zeilen die Karte nicht auseinanderziehen. -->
			<pre
				class="bg-muted max-h-72 overflow-auto rounded-md p-3 text-xs leading-relaxed select-text">{shown.join(
					"\n"
				)}</pre>
		{/if}
	</Card.Content>
</Card.Root>
