<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { BUILTIN_OTHERS, ACTIVITY_COLORS, type Activity } from "$lib/types";
	import { acceleratorFromEvent, applyShortcuts } from "$lib/shortcuts";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Textarea } from "$lib/components/ui/textarea";
	import { Badge } from "$lib/components/ui/badge";
	import * as Card from "$lib/components/ui/card";
	import * as Dialog from "$lib/components/ui/dialog";
	import { toast } from "svelte-sonner";
	import GripVerticalIcon from "@lucide/svelte/icons/grip-vertical";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";
	import ArchiveIcon from "@lucide/svelte/icons/archive";
	import RotateCcwIcon from "@lucide/svelte/icons/rotate-ccw";
	import StarIcon from "@lucide/svelte/icons/star";
	import EyeIcon from "@lucide/svelte/icons/eye";
	import EyeOffIcon from "@lucide/svelte/icons/eye-off";
	import KeyboardIcon from "@lucide/svelte/icons/keyboard";
	import XIcon from "@lucide/svelte/icons/x";

	let pasteText = $state("");
	let newName = $state("");
	let showArchived = $state(false);
	let showHidden = $state(false);
	let fileInput: HTMLInputElement;

	let draggingId = $state<string | null>(null);
	let dragOverId = $state<string | null>(null);
	let dropAfter = $state(false);

	let recordingId = $state<string | null>(null);
	let colorOpenId = $state<string | null>(null);

	// Echtes Löschen (mit allen Einträgen) – Bestätigungsdialog.
	let deleteTarget = $state<Activity | null>(null);
	let deleteCount = $state(-1); // -1 = wird geladen
	let deleting = $state(false);

	async function askDelete(a: Activity) {
		deleteTarget = a;
		deleteCount = -1;
		deleteCount = await app.countActivityEntries(a.id);
	}

	async function confirmDelete() {
		if (!deleteTarget) return;
		deleting = true;
		try {
			const name = deleteTarget.name;
			const n = await app.deleteActivity(deleteTarget.id);
			toast.success(`„${name}" gelöscht${n ? ` (${n} Eintrag/Einträge entfernt)` : ""}.`);
			deleteTarget = null;
		} finally {
			deleting = false;
		}
	}

	async function pickColor(id: string, color: string | null) {
		await app.setColor(id, color);
		colorOpenId = null;
	}

	async function onRecordKey(e: KeyboardEvent) {
		if (!recordingId) return;
		e.preventDefault();
		if (e.key === "Escape") {
			recordingId = null;
			return;
		}
		if (e.key === "Backspace" || e.key === "Delete") {
			await app.setShortcut(recordingId, null);
			recordingId = null;
			await applyShortcuts();
			return;
		}
		const acc = acceleratorFromEvent(e);
		if (!acc) return; // nur Modifier gedrueckt -> weiter warten
		await app.setShortcut(recordingId, acc);
		recordingId = null;
		await applyShortcuts();
	}

	async function clearShortcut(id: string) {
		await app.setShortcut(id, null);
		await applyShortcuts();
	}

	function onDragStart(e: DragEvent, id: string) {
		draggingId = id;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData("text/plain", id); // noetig, damit Drop in der WebView feuert
		}
	}

	function onDragOver(e: DragEvent, id: string) {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		dropAfter = e.clientY > rect.top + rect.height / 2;
		dragOverId = id;
	}

	function onDrop(e: DragEvent, targetId: string) {
		e.preventDefault();
		if (draggingId && draggingId !== targetId) {
			void app.reorderActivity(draggingId, targetId, dropAfter);
		}
		resetDrag();
	}

	function resetDrag() {
		draggingId = null;
		dragOverId = null;
		dropAfter = false;
	}

	function isBuiltin(name: string, isAbsence: boolean): boolean {
		return isAbsence || name === BUILTIN_OTHERS;
	}

	async function doImport(text: string) {
		const lines = text.split(/\r?\n/);
		const added = await app.importActivities(lines);
		toast.success(`${added} Aktivität(en) importiert.`);
		pasteText = "";
	}

	async function onFile(ev: Event) {
		const input = ev.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const text = await file.text();
		await doImport(text);
		input.value = "";
	}

	async function addOne() {
		if (!newName.trim()) return;
		await app.addActivity(newName);
		newName = "";
	}

	const listed = $derived(
		[...app.activities]
			.filter((a) => (showArchived || !a.archived) && (showHidden || !a.hidden || a.archived))
			.sort((a, b) => a.sortOrder - b.sortOrder)
	);
	const hiddenCount = $derived(app.activities.filter((a) => a.hidden && !a.archived).length);
</script>

<svelte:window onkeydown={onRecordKey} />

<div class="grid gap-4 lg:grid-cols-2">
	<Card.Root>
		<Card.Header>
			<Card.Title>Aktivitäten importieren</Card.Title>
			<Card.Description>Jede Zeile wird zu einer Aktivität. Vorhandene bleiben erhalten.</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-3">
			<Textarea
				bind:value={pasteText}
				placeholder={"Project 1\nProject 2\nProject 3\n…"}
				rows={8}
			/>
			<div class="flex flex-wrap gap-2">
				<Button onclick={() => doImport(pasteText)} disabled={!pasteText.trim()}>
					Aus Textfeld importieren
				</Button>
				<Button variant="outline" onclick={() => fileInput.click()}>Aus Datei (.txt)…</Button>
				<input
					bind:this={fileInput}
					type="file"
					accept=".txt,.csv,.text"
					class="hidden"
					onchange={onFile}
				/>
			</div>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Liste ({listed.length})</Card.Title>
			<Card.Action>
				<div class="flex gap-1">
					{#if hiddenCount > 0}
						<Button variant="ghost" size="sm" onclick={() => (showHidden = !showHidden)}>
							{showHidden ? "Ausgeblendete verstecken" : `Ausgeblendete zeigen (${hiddenCount})`}
						</Button>
					{/if}
					<Button variant="ghost" size="sm" onclick={() => (showArchived = !showArchived)}>
						{showArchived ? "Archivierte ausblenden" : "Archivierte zeigen"}
					</Button>
				</div>
			</Card.Action>
		</Card.Header>
		<Card.Content class="space-y-3">
			<div class="flex gap-2">
				<Input bind:value={newName} placeholder="Neue Aktivität…" onkeydown={(e) => e.key === "Enter" && addOne()} />
				<Button onclick={addOne}>Hinzufügen</Button>
			</div>

			<ul class="divide-border divide-y">
				{#each listed as a (a.id)}
					<li
						class="relative flex items-center gap-2 py-1.5"
						class:opacity-40={draggingId === a.id}
						class:opacity-50={a.archived}
						ondragover={(e) => onDragOver(e, a.id)}
						ondrop={(e) => onDrop(e, a.id)}
						role="listitem"
					>
						{#if dragOverId === a.id && draggingId !== a.id}
							<div
								class="bg-primary pointer-events-none absolute inset-x-0 z-10 h-0.5 {dropAfter
									? '-bottom-px'
									: '-top-px'}"
							></div>
						{/if}
						<span
							class="text-muted-foreground hover:text-foreground shrink-0 cursor-grab active:cursor-grabbing"
							draggable={true}
							role="button"
							tabindex="-1"
							ondragstart={(e) => onDragStart(e, a.id)}
							ondragend={resetDrag}
							title="Ziehen zum Sortieren"
							aria-label="Ziehen zum Sortieren"
						>
							<GripVerticalIcon class="size-4" />
						</span>
						{#if !isBuiltin(a.name, a.isAbsence)}
							<div class="relative shrink-0">
								<button
									type="button"
									class="border-border size-4 cursor-pointer rounded-full border"
									style={`background:${a.color ?? "transparent"}`}
									title="Farbe wählen"
									aria-label="Farbe wählen"
									onclick={() => (colorOpenId = colorOpenId === a.id ? null : a.id)}
								></button>
								{#if colorOpenId === a.id}
									<div
										class="bg-popover absolute left-0 top-6 z-20 flex w-32 flex-wrap gap-1 rounded-md border p-2 shadow-md"
									>
										{#each ACTIVITY_COLORS as c (c)}
											<button
												type="button"
												class="size-5 cursor-pointer rounded-full ring-offset-1 hover:ring-2"
												style={`background:${c}`}
												aria-label={c}
												onclick={() => pickColor(a.id, c)}
											></button>
										{/each}
										<button
											type="button"
											class="text-muted-foreground hover:text-foreground mt-1 w-full cursor-pointer text-left text-xs"
											onclick={() => pickColor(a.id, null)}
										>
											Farbe entfernen
										</button>
									</div>
								{/if}
							</div>
						{/if}
						<input
							class="flex-1 bg-transparent text-sm outline-none"
							value={a.name}
							onchange={(e: Event) => app.renameActivity(a.id, (e.target as HTMLInputElement).value)}
						/>
						{#if a.hidden && !a.archived}
							<Badge variant="outline">ausgeblendet</Badge>
						{/if}
						{#if !isBuiltin(a.name, a.isAbsence)}
							{#if recordingId === a.id}
								<span class="text-muted-foreground shrink-0 text-xs italic">
									Taste drücken… (Esc=Abbruch)
								</span>
							{:else if a.shortcut}
								<button
									class="border-input bg-muted hover:bg-accent rounded border px-1.5 py-0.5 font-mono text-xs"
									title="Shortcut ändern"
									onclick={() => (recordingId = a.id)}
								>
									{a.shortcut}
								</button>
								<Button
									variant="ghost"
									size="icon"
									class="size-6"
									title="Shortcut entfernen"
									onclick={() => clearShortcut(a.id)}
								>
									<XIcon class="size-3.5" />
								</Button>
							{:else}
								<Button
									variant="ghost"
									size="icon"
									title="Globalen Shortcut festlegen"
									onclick={() => (recordingId = a.id)}
								>
									<KeyboardIcon class="size-4" />
								</Button>
							{/if}
							<Button
								variant="ghost"
								size="icon"
								title={a.favorite ? "Favorit entfernen" : "Als Favorit markieren"}
								onclick={() => app.toggleFavorite(a.id)}
							>
								<StarIcon class={"size-4 " + (a.favorite ? "fill-yellow-400 text-yellow-400" : "")} />
							</Button>
							{#if !a.archived}
								<Button
									variant="ghost"
									size="icon"
									title={a.hidden ? "In Auswahl einblenden" : "Aus Auswahl ausblenden (bleibt im Bericht)"}
									onclick={() => app.toggleHidden(a.id)}
								>
									{#if a.hidden}
										<EyeOffIcon class="size-4" />
									{:else}
										<EyeIcon class="size-4" />
									{/if}
								</Button>
							{/if}
						{/if}
						{#if isBuiltin(a.name, a.isAbsence)}
							<Badge variant="secondary">fix</Badge>
						{:else}
							{#if a.archived}
								<Button variant="ghost" size="icon" title="Wiederherstellen (zurück in die Auswahl)" onclick={() => app.setArchived(a.id, false)}>
									<RotateCcwIcon class="size-4" />
								</Button>
							{:else}
								<Button
									variant="ghost"
									size="icon"
									title="Archivieren – aus Auswahl/Timer entfernen; erfasste Stunden bleiben im Bericht"
									onclick={() => app.setArchived(a.id, true)}
								>
									<ArchiveIcon class="size-4" />
								</Button>
							{/if}
							<Button
								variant="ghost"
								size="icon"
								title="Löschen – Aktivität und alle Einträge unwiderruflich entfernen"
								onclick={() => askDelete(a)}
							>
								<Trash2Icon class="text-destructive size-4" />
							</Button>
						{/if}
					</li>
				{/each}
			</ul>
		</Card.Content>
	</Card.Root>
</div>

<Dialog.Root open={!!deleteTarget} onOpenChange={(v) => { if (!v && !deleting) deleteTarget = null; }}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Aktivität löschen?</Dialog.Title>
			<Dialog.Description>
				„{deleteTarget?.name}" wird
				{#if deleteCount < 0}
					mit allen zugehörigen Einträgen
				{:else if deleteCount === 0}
					(keine Einträge vorhanden)
				{:else}
					<strong>samt {deleteCount} Eintrag/Einträgen</strong>
				{/if}
				unwiderruflich gelöscht. Diese Daten sind danach weg – auch aus dem Bericht.
				Zum reinen Ausblenden lieber <em>Archivieren</em> nutzen.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button type="button" variant="outline" onclick={() => (deleteTarget = null)} disabled={deleting}>
				Abbrechen
			</Button>
			<Button type="button" variant="destructive" onclick={confirmDelete} disabled={deleting}>
				<Trash2Icon class="size-4" />
				{deleting ? "Lösche…" : "Endgültig löschen"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
