<script lang="ts">
	// Suchbare Aktivitäts-Auswahl (Combobox). `value` ist die activityId ("" = keine).
	// Wird im Eintrag-Dialog und in der Schnelleingabe gemeinsam genutzt.
	import { app } from "$lib/app.svelte";
	import { Input } from "$lib/components/ui/input";
	import type { Activity } from "$lib/types";

	let {
		value = $bindable(""),
		options,
		id = "activity",
		placeholder = "Aktivität wählen oder suchen"
	}: {
		value?: string;
		options: Activity[];
		id?: string;
		placeholder?: string;
	} = $props();

	let text = $state("");
	let open = $state(false);
	let index = $state(0);

	// Anzeigetext an `value` koppeln, solange die Liste geschlossen ist
	// (beim Tippen nicht überschreiben). Deckt externes Setzen/Reset ab.
	$effect(() => {
		if (!open) text = value ? app.activityName(value) : "";
	});

	const filtered = $derived.by(() => {
		const q = text.trim().toLowerCase();
		const selName = value ? app.activityName(value).toLowerCase() : "";
		if (!q || q === selName) return options;
		return options.filter((a) => a.name.toLowerCase().includes(q));
	});

	function onInput(v: string) {
		text = v;
		open = true;
		const match = options.find((a) => a.name.toLowerCase() === v.trim().toLowerCase());
		value = match?.id ?? "";
		index = match ? Math.max(0, filtered.findIndex((a) => a.id === match.id)) : 0;
	}
	function openList() {
		open = true;
		index = Math.max(
			0,
			filtered.findIndex((a) => a.id === value)
		);
	}
	function select(a: Activity) {
		value = a.id;
		text = a.name;
		open = false;
	}
	/** Beim Verlassen nur exakte Treffer zulassen, sonst auf letzte gültige Auswahl zurück. */
	function commit() {
		const match = options.find((a) => a.name.toLowerCase() === text.trim().toLowerCase());
		if (match) {
			value = match.id;
			text = match.name;
		} else {
			text = value ? app.activityName(value) : "";
		}
		open = false;
	}
	function onKeydown(e: KeyboardEvent) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			if (!open) return openList();
			index = Math.min(index + 1, filtered.length - 1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			index = Math.max(index - 1, 0);
		} else if (e.key === "Enter") {
			if (open && filtered[index]) {
				e.preventDefault();
				select(filtered[index]);
			}
		} else if (e.key === "Escape") {
			if (open) {
				e.stopPropagation();
				commit();
			}
		}
	}
</script>

<div class="relative">
	<Input
		{id}
		role="combobox"
		aria-expanded={open}
		autocomplete="off"
		{placeholder}
		value={text}
		oninput={(e) => onInput(e.currentTarget.value)}
		onfocus={openList}
		onclick={openList}
		onblur={commit}
		onkeydown={onKeydown}
	/>
	{#if open}
		<ul
			role="listbox"
			class="bg-popover text-popover-foreground absolute z-50 mt-1 max-h-52 w-full overflow-y-auto rounded-md border p-1 shadow-md"
		>
			{#if filtered.length === 0}
				<li class="text-muted-foreground px-2 py-1.5 text-sm">Keine Aktivität gefunden</li>
			{:else}
				{#each filtered as a, i (a.id)}
					<li>
						<button
							type="button"
							class="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm {i === index
								? 'bg-accent text-accent-foreground'
								: ''}"
							onmousedown={(e) => {
								e.preventDefault();
								select(a);
							}}
							onmouseenter={() => (index = i)}
						>
							{a.name}
						</button>
					</li>
				{/each}
			{/if}
		</ul>
	{/if}
</div>
