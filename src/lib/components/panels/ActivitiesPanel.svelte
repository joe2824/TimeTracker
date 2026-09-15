<script lang="ts">
	import { app } from "$lib/app.svelte";
	import {
		BUILTIN_OTHERS,
		ACTIVITY_COLORS,
		byActivityOrder,
		isBuiltinActivity,
		type Activity
	} from "$lib/types";
	import { acceleratorFromEvent, applyShortcuts } from "$lib/ui/shortcuts";
	import { account } from "$lib/sync/account.svelte";
	import { chefTeams } from "$lib/team/chef.svelte";
	import { syncOwnedTeamActivities, TEAM_ACTIVITY_PREFIX } from "$lib/team/activities";
	import { ApiError, type TeamActivity, type TeamActivityInput } from "$lib/sync/api";
	import { errorText } from "$lib/log";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Textarea } from "$lib/components/ui/textarea";
	import { Badge } from "$lib/components/ui/badge";
	import * as Card from "$lib/components/ui/card";
	import * as Dialog from "$lib/components/ui/dialog";
	import * as Select from "$lib/components/ui/select";
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
	import UsersIcon from "@lucide/svelte/icons/users";
	import GitMergeIcon from "@lucide/svelte/icons/git-merge";
	import ShortcutKey from "$lib/components/shared/ShortcutKey.svelte";

	let pasteText = $state("");
	let newName = $state("");
	let showArchived = $state(false);
	let showHidden = $state(false);
	/** "alle" oder die Id eines selbst geführten Teams - blendet alles andere aus. */
	let activityTeamFilter = $state("alle");
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

	// Zwei Aktivitäten zusammenführen – vor allem für "meine eigene ist dasselbe
	// wie die neu angekommene Team-Aktivität": alle Einträge wandern mit, nichts
	// geht verloren, nur die eigene Zeile verschwindet.
	let mergeSource = $state<Activity | null>(null);
	let mergeTargetId = $state<string | undefined>(undefined);
	let merging = $state(false);

	function askMerge(a: Activity) {
		mergeSource = a;
		mergeTargetId = undefined;
	}

	async function confirmMerge() {
		if (!mergeSource || !mergeTargetId) return;
		merging = true;
		try {
			const fromName = mergeSource.name;
			const toName = app.activities.find((x) => x.id === mergeTargetId)?.name ?? "";
			const moved = await app.mergeActivityInto(mergeSource.id, mergeTargetId);
			toast.success(
				`„${fromName}" in „${toName}" zusammengeführt${moved ? ` (${moved} Eintrag/Einträge)` : ""}.`
			);
			mergeSource = null;
		} finally {
			merging = false;
		}
	}

	// Dieselbe Zusammenführung, nur mit fester Richtung: eine Team-Aktivität darf
	// nie die verschwindende Seite sein - der naechste Abgleich brächte sie
	// unveraendert zurueck, weil der Server sie weiterhin fuehrt. Nur die
	// EIGENE Aktivitaet darf also die Quelle sein, die Team-Zeile bleibt fest
	// das Ziel.
	let mergeIntoTarget = $state<Activity | null>(null);
	let mergeSourceId = $state<string | undefined>(undefined);

	function askMergeInto(a: Activity) {
		const target = app.activities.find((x) => x.id === realId(a.id));
		if (!target) return;
		mergeIntoTarget = target;
		mergeSourceId = undefined;
	}

	const ownCandidates = $derived(app.activities.filter((a) => !a.teamOwned && !isBuiltinActivity(a)));

	async function confirmMergeInto() {
		if (!mergeIntoTarget || !mergeSourceId) return;
		merging = true;
		try {
			const fromName = app.activityName(mergeSourceId);
			const toName = mergeIntoTarget.name;
			const moved = await app.mergeActivityInto(mergeSourceId, mergeIntoTarget.id);
			toast.success(
				`„${fromName}" in „${toName}" zusammengeführt${moved ? ` (${moved} Eintrag/Einträge)` : ""}.`
			);
			mergeIntoTarget = null;
		} finally {
			merging = false;
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
		if (!acc) return; // nur Modifier gedrückt -> weiter warten
		await app.setShortcut(recordingId, acc);
		recordingId = null;
		await applyShortcuts();
	}

	async function clearShortcut(id: string) {
		await app.setShortcut(id, null);
		await applyShortcuts();
	}

	function isReorderable(id: string): boolean {
		// Nur die gerade zur Bearbeitung ausgewählte Team-Liste - Sortieren
		// zwischen zwei verschiedenen Teams (oder Team und eigenen Zeilen) hat
		// keine gemeinsame Reihenfolge, gegen die sich das sinnvoll aufloesen liesse.
		if (isChefTeamRow(id)) return true;
		const a = app.activities.find((x) => x.id === id);
		return !!a && !isBuiltinActivity(a) && !a.teamOwned;
	}

	/** Wie app.reorderActivity, nur für den Team-Entwurf - persistiert über die Team-API. */
	function reorderTeamActivity(draggedRawId: string, targetRawId: string, placeAfter: boolean) {
		const ordered = [...teamActivities].sort((a, b) => a.sortOrder - b.sortOrder);
		const from = ordered.findIndex((a) => a.id === draggedRawId);
		if (from < 0) return;
		const [moved] = ordered.splice(from, 1);
		let to = ordered.findIndex((a) => a.id === targetRawId);
		if (to < 0) return;
		if (placeAfter) to += 1;
		ordered.splice(to, 0, moved);
		void saveTeamActivities(ordered.map((a, i) => toTeamInput({ ...a, sortOrder: i })));
	}

	function onDragStart(e: DragEvent, id: string) {
		if (!isReorderable(id)) return;
		draggingId = id;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData("text/plain", id); // nötig, damit Drop in der WebView feuert
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
			if (isChefTeamRow(draggingId) && isChefTeamRow(targetId)) {
				reorderTeamActivity(teamRowId(draggingId), teamRowId(targetId), dropAfter);
			} else if (!isChefTeamRow(draggingId) && !isChefTeamRow(targetId)) {
				void app.reorderActivity(draggingId, targetId, dropAfter);
			}
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

	// ---------- Gemeinsame Team-Aktivitäten (nur als Chef sichtbar/bearbeitbar) ----------
	//
	// Eigene Herkunft, getrennt von app.activities: die vom Team synchronisierten
	// teamOwned-Zeilen (team/activities.ts, Präfix "team:") kommen nur auf
	// GERÄTEN AN, die dem Team über den Beitritts-Link angehören - nicht auf dem
	// Konto-Gerät des Chefs selbst. Dessen eigene Sicht auf die von ihm
	// verwaltete Liste holt sich dieser Block direkt über die Team-API, wie
	// vorher im Team-Tab.
	const TEAM_EDIT_PREFIX = "team-edit:";
	const isChefTeamRow = (id: string) => id.startsWith(TEAM_EDIT_PREFIX);
	const teamRowId = (id: string) => id.slice(TEAM_EDIT_PREFIX.length);
	/** Favorit/Ausblenden/Shortcut gehören der gespiegelten Zeile in app.activities, nicht dem Team-Entwurf. */
	const realId = (id: string) => (isChefTeamRow(id) ? `${TEAM_ACTIVITY_PREFIX}${teamRowId(id)}` : id);

	let teamActivities = $state<TeamActivity[]>([]);
	let teamActivitiesVersion = $state(0);
	let teamActionBusy = $state(false);

	async function loadTeamActivities(teamId: string) {
		try {
			const act = await account.listTeamActivities(teamId);
			if (teamId !== chefTeams.selectedTeamId) return;
			teamActivities = act;
			teamActivitiesVersion = act.reduce((max, a) => Math.max(max, a.updatedAt), 0);
		} catch (e) {
			toast.error(`Team-Aktivitäten konnten nicht geladen werden: ${errorText(e)}`);
		}
	}

	$effect(() => {
		if (account.linked) void chefTeams.loadTeams();
	});
	$effect(() => {
		if (chefTeams.selectedTeamId) void loadTeamActivities(chefTeams.selectedTeamId);
		else teamActivities = [];
	});
	// Auf ein Team gefiltert heisst auch: dieses Team ist die bearbeitbare
	// Auswahl - sonst zeigte der Filter ein Team, dessen Zeilen (teamListed)
	// aber noch die vorige Auswahl waeren.
	$effect(() => {
		if (activityTeamFilter !== "alle") chefTeams.selectedTeamId = activityTeamFilter;
	});

	function toTeamInput(a: TeamActivity): TeamActivityInput {
		return { id: a.id, name: a.name, isAbsence: a.isAbsence, sortOrder: a.sortOrder, color: a.color, archived: a.archived };
	}

	/** Die ganze Liste des ausgewählten Teams neu schreiben - der Server nimmt keine Einzel-Patches. */
	async function saveTeamActivities(next: TeamActivityInput[]) {
		if (!chefTeams.selectedTeamId || teamActionBusy) return;
		const teamId = chefTeams.selectedTeamId;
		teamActionBusy = true;
		try {
			const saved = await account.setTeamActivities(teamId, next, teamActivitiesVersion);
			if (teamId === chefTeams.selectedTeamId) {
				teamActivities = saved;
				teamActivitiesVersion = saved.reduce((max, a) => Math.max(max, a.updatedAt), 0);
			}
			// Sonst sieht die eigene Zeiterfassung (Auswahl, Ausblenden) die Änderung
			// erst beim nächsten App-Start.
			void syncOwnedTeamActivities();
		} catch (e) {
			if (e instanceof ApiError && e.status === 409) {
				toast.error("Die Team-Liste wurde inzwischen anderswo geändert - neu geladen.");
				if (teamId === chefTeams.selectedTeamId) await loadTeamActivities(teamId);
			} else {
				toast.error(`Speichern fehlgeschlagen: ${errorText(e)}`);
			}
		} finally {
			teamActionBusy = false;
		}
	}

	async function renameTeamActivity(id: string, name: string) {
		const trimmed = name.trim();
		if (!trimmed) return;
		await saveTeamActivities(
			teamActivities.map((a) => toTeamInput(a.id === id ? { ...a, name: trimmed } : a))
		);
	}

	async function deleteTeamActivity(id: string) {
		await saveTeamActivities(teamActivities.filter((a) => a.id !== id).map(toTeamInput));
	}

	/** Namen importieren, die es im Team noch nicht gibt - wie app.importActivities, nur serverseitig. */
	async function importTeamActivities(teamId: string, lines: string[]): Promise<number> {
		const isSelected = teamId === chefTeams.selectedTeamId;
		const current = isSelected ? teamActivities : await account.listTeamActivities(teamId);
		const version = isSelected
			? teamActivitiesVersion
			: current.reduce((max, a) => Math.max(max, a.updatedAt), 0);

		const existing = new Set(current.map((a) => a.name.toLowerCase()));
		const toAdd: TeamActivityInput[] = [];
		let order = current.length;
		for (const raw of lines) {
			const name = raw.trim();
			if (!name || existing.has(name.toLowerCase())) continue;
			existing.add(name.toLowerCase());
			toAdd.push({ name, isAbsence: false, sortOrder: order++, archived: false });
		}
		if (toAdd.length === 0) return 0;

		const saved = await account.setTeamActivities(teamId, [...current.map(toTeamInput), ...toAdd], version);
		if (isSelected) {
			teamActivities = saved;
			teamActivitiesVersion = saved.reduce((max, a) => Math.max(max, a.updatedAt), 0);
		}
		return toAdd.length;
	}

	/** Wohin der Text-/Datei-Import geht: "eigene" oder die Id eines Teams, das dieses Konto führt. */
	let importTarget = $state("eigene");

	async function doImport(text: string) {
		const lines = text.split(/\r?\n/);
		if (importTarget === "eigene") {
			const added = await app.importActivities(lines);
			toast.success(`${added} Aktivität(en) importiert.`);
		} else {
			try {
				const added = await importTeamActivities(importTarget, lines);
				toast.success(`${added} Aktivität(en) ins Team importiert.`);
			} catch (e) {
				toast.error(`Import fehlgeschlagen: ${errorText(e)}`);
				return;
			}
		}
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

	/** Ein Feld für beides: personlich oder ins gefilterte Team, je nach Filter. */
	async function addOne() {
		const name = newName.trim();
		if (!name) return;
		if (activityTeamFilter !== "alle") {
			if (!chefTeams.selectedTeamId) return;
			await saveTeamActivities([
				...teamActivities.map(toTeamInput),
				{ name, isAbsence: false, sortOrder: teamActivities.length, archived: false }
			]);
		} else {
			await app.addActivity(name);
		}
		newName = "";
	}

	/**
	 * Die eigene Sicht des Chefs auf die Team-Liste, in Aktivitäts-Form fürs
	 * gemeinsame Rendern. Name/Löschen laufen über die Team-API (chefTeams),
	 * aber Favorit/Ausblenden/Shortcut sind Geräte-Einstellungen und gehören
	 * der gespiegelten Zeile in app.activities (syncOwnedTeamActivities) - hier
	 * nur übernommen, damit ein Umschalten nicht ins Leere greift.
	 */
	const teamListed = $derived(
		teamActivities
			.filter((a) => showArchived || !a.archived)
			.map((a): Activity => {
				const mirrored = app.activities.find((m) => m.id === `${TEAM_ACTIVITY_PREFIX}${a.id}`);
				return {
					id: `${TEAM_EDIT_PREFIX}${a.id}`,
					name: a.name,
					sortOrder: a.sortOrder,
					archived: a.archived,
					isAbsence: a.isAbsence,
					teamOwned: true,
					teamId: chefTeams.selectedTeamId,
					teamName: chefTeams.selectedTeam?.name,
					favorite: mirrored?.favorite,
					hidden: mirrored?.hidden,
					shortcut: mirrored?.shortcut
				} as Activity;
			})
	);

	const listed = $derived(
		[
			...app.activities.filter(
				(a) =>
					(showArchived || !a.archived) &&
					(showHidden || !a.hidden || a.archived) &&
					// Das aktuell ausgewaehlte Team zeigt teamListed - dieselbe Zeile
					// spiegelt syncOwnedTeamActivities sonst zusaetzlich aus app.activities.
					!(a.teamOwned && a.teamId === chefTeams.selectedTeamId) &&
					(activityTeamFilter === "alle" || a.teamId === activityTeamFilter)
			),
			...(activityTeamFilter === "alle" || activityTeamFilter === chefTeams.selectedTeamId
				? teamListed
				: [])
		].sort(byActivityOrder)
	);
	const hiddenCount = $derived(app.activities.filter((a) => a.hidden && !a.archived).length);
	/** Wohin sich eine Aktivität zusammenführen lässt - alles ausser sich selbst und Eingebautem. */
	const mergeCandidates = $derived(
		app.activities.filter((a) => a.id !== mergeSource?.id && !isBuiltinActivity(a))
	);
</script>

<svelte:window onkeydown={onRecordKey} />

<div class="grid gap-4 lg:grid-cols-2">
	<Card.Root>
		<Card.Header>
			<Card.Title>Aktivitäten importieren</Card.Title>
			<Card.Description>Jede Zeile wird zu einer Aktivität. Vorhandene bleiben erhalten.</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-3">
			{#if chefTeams.teams.length > 0}
				<div class="flex items-center gap-2">
					<span class="text-muted-foreground text-sm">Ziel</span>
					<Select.Root type="single" bind:value={importTarget}>
						<Select.Trigger class="w-56">
							{importTarget === "eigene"
								? "Eigene Aktivitäten"
								: (chefTeams.teams.find((t) => t.id === importTarget)?.name ?? "Eigene Aktivitäten")}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="eigene" label="Eigene Aktivitäten">Eigene Aktivitäten</Select.Item>
							{#each chefTeams.teams as t (t.id)}
								<Select.Item value={t.id} label={t.name}>Team „{t.name}"</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>
			{/if}
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
				<div class="flex flex-wrap gap-1">
					{#if chefTeams.teams.length > 0}
						<Select.Root type="single" bind:value={activityTeamFilter}>
							<Select.Trigger class="w-44" size="sm">
								{activityTeamFilter === "alle"
									? "Alle Aktivitäten"
									: `Nur ${chefTeams.teams.find((t) => t.id === activityTeamFilter)?.name ?? "Team"}`}
							</Select.Trigger>
							<Select.Content>
								<Select.Item value="alle" label="Alle Aktivitäten">Alle Aktivitäten</Select.Item>
								{#each chefTeams.teams as t (t.id)}
									<Select.Item value={t.id} label={t.name}>Nur „{t.name}"</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					{/if}
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
				<Input
					bind:value={newName}
					placeholder={activityTeamFilter === "alle" ? "Neue Aktivität…" : "Neue Team-Aktivität…"}
					onkeydown={(e) => e.key === "Enter" && addOne()}
				/>
				<Button onclick={addOne} disabled={activityTeamFilter !== "alle" && teamActionBusy}>
					{#if activityTeamFilter !== "alle"}<UsersIcon class="size-4" />{/if} Hinzufügen
				</Button>
			</div>

			<ul class="divide-border divide-y">
				{#each listed as a (a.id)}
					<li
						class="relative flex flex-wrap items-center gap-2 py-1.5"
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
							class={isReorderable(a.id)
								? "text-muted-foreground hover:text-foreground shrink-0 cursor-grab active:cursor-grabbing"
								: "text-muted-foreground/40 shrink-0 cursor-default"}
							draggable={isReorderable(a.id)}
							role="button"
							tabindex="-1"
							ondragstart={(e) => onDragStart(e, a.id)}
							ondragend={resetDrag}
							title={isReorderable(a.id) ? "Ziehen zum Sortieren" : "Vom Team vorgegebene und eingebaute Zeilen lassen sich nicht per Ziehen umsortieren"}
							aria-label="Ziehen zum Sortieren"
						>
							<GripVerticalIcon class="size-4" />
						</span>
						{#if !isBuiltin(a.name, a.isAbsence) && !isChefTeamRow(a.id)}
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
						<!-- Eingebaute Zeilen nicht umbenennbar: #seedBuiltins erkennt sie am
						     Namen und legte sonst beim nächsten Start eine zweite an. -->
						<!-- min-w-0: ohne das setzt das Feld seine intrinsische Breite durch und
						     schiebt die Knöpfe aus der Zeile. basis-40 lässt die Knöpfe
						     umbrechen, bevor vom Namen nichts mehr übrig ist. -->
						<input
							class="hover:bg-muted/60 focus:bg-muted/60 focus-visible:ring-ring/50 min-w-0 grow basis-40 rounded-md bg-transparent px-1.5 py-1 text-sm transition-colors outline-none focus-visible:ring-3 disabled:cursor-default disabled:bg-transparent disabled:opacity-100"
							value={a.name}
							disabled={isBuiltinActivity(a) || (a.teamOwned && !isChefTeamRow(a.id))}
							title={isBuiltinActivity(a)
								? "Eingebaute Zeile – nicht umbenennbar"
								: a.teamOwned && !isChefTeamRow(a.id)
									? "Vom Team vorgegeben – nur der Chef kann sie ändern"
									: "Umbenennen"}
							onchange={(e: Event) => {
								const value = (e.target as HTMLInputElement).value;
								if (isChefTeamRow(a.id)) void renameTeamActivity(teamRowId(a.id), value);
								else app.renameActivity(a.id, value);
							}}
						/>
						{#if a.teamOwned}
							<Badge variant="outline" class="shrink-0 gap-1" title="Vom Chef vorgegeben, für alle im Team gleich">
								<UsersIcon class="size-3" /> {a.teamName ?? "Team"}
							</Badge>
						{/if}
						<!-- Aktionen als eine Gruppe, nicht als fünf lose Knöpfe: so brechen
						     sie geschlossen um und lesen sich als ein Satz Werkzeuge zu dieser
						     Zeile. gap-0.5, weil sie zusammengehören. -->
						<div class="ml-auto flex shrink-0 items-center gap-0.5">
						{#if a.hidden && !a.archived}
							<Badge variant="outline" class="mr-1">ausgeblendet</Badge>
						{/if}
						{#if !isBuiltin(a.name, a.isAbsence)}
							{#if recordingId === realId(a.id)}
								<span class="text-muted-foreground shrink-0 text-xs italic">
									Taste drücken… (Esc=Abbruch)
								</span>
							{:else if a.shortcut}
								<ShortcutKey shortcut={a.shortcut} onclick={() => (recordingId = realId(a.id))} />
								<Button
									variant="ghost"
									size="icon"
									class="size-6"
									title="Shortcut entfernen"
									onclick={() => clearShortcut(realId(a.id))}
								>
									<XIcon class="size-3.5" />
								</Button>
							{:else}
								<Button
									variant="ghost"
									size="icon"
									title="Globalen Shortcut festlegen"
									onclick={() => (recordingId = realId(a.id))}
								>
									<KeyboardIcon class="size-4" />
								</Button>
							{/if}
							<Button
								variant="ghost"
								size="icon-sm"
								title={a.favorite ? "Favorit entfernen" : "Als Favorit markieren"}
								onclick={() => app.toggleFavorite(realId(a.id))}
							>
								<StarIcon class={"size-4 " + (a.favorite ? "fill-yellow-400 text-yellow-400" : "")} />
							</Button>
							{#if !a.archived}
								<Button
									variant="ghost"
									size="icon-sm"
									title={a.hidden ? "In Auswahl einblenden" : "Aus Auswahl ausblenden (bleibt im Bericht)"}
									onclick={() => app.toggleHidden(realId(a.id))}
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
						{:else if a.teamOwned && isChefTeamRow(a.id)}
							<Button
								variant="ghost"
								size="icon-sm"
								title="Eigene Aktivität hier zusammenführen – z.B. wenn sie dasselbe war, bevor das Team sie vorgab"
								onclick={() => askMergeInto(a)}
							>
								<GitMergeIcon class="size-4" />
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								disabled={teamActionBusy}
								title="Aus der Team-Liste entfernen – verschwindet auf allen Geräten des Teams"
								onclick={() => deleteTeamActivity(teamRowId(a.id))}
							>
								<Trash2Icon class="text-destructive size-4" />
							</Button>
						{:else if a.teamOwned}
							<!-- Ändern/Löschen nur im Aktivitäten-Tab des Chefs - eine lokale
							     Löschung käme beim nächsten Abgleich ohnehin zurück. Die eigene,
							     nun überflüssige Aktivität lässt sich aber hier hinein zusammenführen. -->
							<Button
								variant="ghost"
								size="icon-sm"
								title="Eigene Aktivität hier zusammenführen – z.B. wenn sie dasselbe war, bevor das Team sie vorgab"
								onclick={() => askMergeInto(a)}
							>
								<GitMergeIcon class="size-4" />
							</Button>
						{:else}
							<Button
								variant="ghost"
								size="icon-sm"
								title="Mit einer anderen Aktivität zusammenführen – alle Einträge wandern mit, nichts geht verloren"
								onclick={() => askMerge(a)}
							>
								<GitMergeIcon class="size-4" />
							</Button>
							{#if a.archived}
								<Button variant="ghost" size="icon-sm" title="Wiederherstellen (zurück in die Auswahl)" onclick={() => app.setArchived(a.id, false)}>
									<RotateCcwIcon class="size-4" />
								</Button>
							{:else}
								<Button
									variant="ghost"
									size="icon-sm"
									title="Archivieren – aus Auswahl/Timer entfernen; erfasste Stunden bleiben im Bericht"
									onclick={() => app.setArchived(a.id, true)}
								>
									<ArchiveIcon class="size-4" />
								</Button>
							{/if}
							<Button
								variant="ghost"
								size="icon-sm"
								title="Löschen – Aktivität und alle Einträge unwiderruflich entfernen"
								onclick={() => askDelete(a)}
							>
								<Trash2Icon class="text-destructive size-4" />
							</Button>
						{/if}
						</div>
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

<Dialog.Root open={!!mergeSource} onOpenChange={(v) => { if (!v && !merging) mergeSource = null; }}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>„{mergeSource?.name}" zusammenführen</Dialog.Title>
			<Dialog.Description>
				Alle Einträge wandern zur ausgewählten Aktivität, „{mergeSource?.name}" verschwindet danach
				aus der Liste. Nützlich, wenn eine eigene Aktivität dasselbe ist wie eine vom Team
				vorgegebene – nichts geht dabei verloren.
			</Dialog.Description>
		</Dialog.Header>
		{#if mergeCandidates.length === 0}
			<p class="text-muted-foreground text-sm">Keine andere Aktivität vorhanden.</p>
		{:else}
			<Select.Root type="single" bind:value={mergeTargetId}>
				<Select.Trigger>
					{mergeTargetId ? app.activityName(mergeTargetId) : "Ziel wählen"}
				</Select.Trigger>
				<Select.Content>
					{#each mergeCandidates as c (c.id)}
						<Select.Item value={c.id} label={c.name}>
							{c.name}{c.teamOwned ? " (Team)" : ""}
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		{/if}
		<Dialog.Footer>
			<Button type="button" variant="outline" onclick={() => (mergeSource = null)} disabled={merging}>
				Abbrechen
			</Button>
			<Button type="button" onclick={confirmMerge} disabled={merging || !mergeTargetId}>
				<GitMergeIcon class="size-4" />
				{merging ? "Wird zusammengeführt…" : "Zusammenführen"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={!!mergeIntoTarget} onOpenChange={(v) => { if (!v && !merging) mergeIntoTarget = null; }}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>In „{mergeIntoTarget?.name}" zusammenführen</Dialog.Title>
			<Dialog.Description>
				Alle Einträge der ausgewählten eigenen Aktivität wandern zu „{mergeIntoTarget?.name}", sie
				verschwindet danach aus der Liste. Nützlich, wenn sie dasselbe war, bevor das Team sie
				vorgab – nichts geht dabei verloren.
			</Dialog.Description>
		</Dialog.Header>
		{#if ownCandidates.length === 0}
			<p class="text-muted-foreground text-sm">Keine eigene Aktivität vorhanden.</p>
		{:else}
			<Select.Root type="single" bind:value={mergeSourceId}>
				<Select.Trigger>
					{mergeSourceId ? app.activityName(mergeSourceId) : "Eigene Aktivität wählen"}
				</Select.Trigger>
				<Select.Content>
					{#each ownCandidates as c (c.id)}
						<Select.Item value={c.id} label={c.name}>{c.name}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		{/if}
		<Dialog.Footer>
			<Button type="button" variant="outline" onclick={() => (mergeIntoTarget = null)} disabled={merging}>
				Abbrechen
			</Button>
			<Button type="button" onclick={confirmMergeInto} disabled={merging || !mergeSourceId}>
				<GitMergeIcon class="size-4" />
				{merging ? "Wird zusammengeführt…" : "Zusammenführen"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
