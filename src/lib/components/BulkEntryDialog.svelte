<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { fmtDate, fmtHours, parseClock, parseHours } from "$lib/time";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Switch } from "$lib/components/ui/switch";
	import * as Dialog from "$lib/components/ui/dialog";
	import { toast } from "svelte-sonner";

	let {
		open = $bindable(false),
		month,
		onsaved
	}: { open?: boolean; month: string; onsaved: () => void } = $props();

	let mode = $state<"days" | "lump">("days");
	let activityId = $state(app.visibleActivities[0]?.id ?? "");
	const isAbsence = $derived(app.isAbsenceId(activityId));

	// Mehrere Tage (Datums-Defaults kommen aus dem $effect unten)
	let von = $state("");
	let bis = $state("");
	let onlyWeekdays = $state(true);
	let start = $state("08:00");
	let end = $state("16:00");
	let startText = $state("08:00"); // Roh-Eingabe, erst beim Verlassen normalisiert
	let endText = $state("16:00");
	let fraction = $state(1);

	// Pauschal (Summe auf einen Tag)
	let lumpDate = $state("");
	let lumpHours = $state("8");

	/** Uhrzeit-Eingabe beim Verlassen normalisieren (z.B. "1800" -> "18:00"). */
	function commitStart() {
		const p = parseClock(startText);
		if (p) start = p;
		startText = start;
	}
	function commitEnd() {
		const p = parseClock(endText);
		if (p) end = p;
		endText = end;
	}

	$effect(() => {
		// Wenn der Monat wechselt, Default-Daten anpassen.
		von = `${month}-01`;
		bis = `${month}-01`;
		lumpDate = `${month}-01`;
	});

	function toTs(date: string, time: string): number {
		return new Date(`${date}T${time}:00`).getTime();
	}

	async function saveDays() {
		commitStart();
		commitEnd();
		const a = new Date(`${von}T12:00:00`);
		const b = new Date(`${bis}T12:00:00`);
		if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || a > b) {
			toast.error("Ungültiger Datumsbereich.");
			return;
		}
		let count = 0;
		for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
			const wd = d.getDay();
			if (onlyWeekdays && (wd === 0 || wd === 6)) continue;
			const date = fmtDate(d.getTime());
			if (isAbsence) {
				const ts = toTs(date, "12:00");
				await app.addEntry(activityId, ts, ts, "", "manual", fraction);
			} else {
				let s = toTs(date, start);
				let e = toTs(date, end);
				if (e < s) e += 24 * 3600 * 1000;
				await app.addEntry(activityId, s, e, "", "manual");
			}
			count++;
		}
		toast.success(`${count} Eintrag/Einträge angelegt.`);
		open = false;
		onsaved();
	}

	async function saveLump() {
		const hours = parseHours(lumpHours);
		if (hours == null || hours <= 0) {
			toast.error("Bitte gültige Stundenzahl angeben.");
			return;
		}
		const s = toTs(lumpDate, "08:00");
		const e = s + hours * 3600 * 1000;
		await app.addEntry(activityId, s, e, "Pauschaleintrag", "manual");
		toast.success(`${fmtHours(hours)} h angelegt.`);
		open = false;
		onsaved();
	}

	/** Enter bestätigt den jeweils aktiven Modus (Pauschal bei Abwesenheit gesperrt). */
	function onSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (mode === "days") saveDays();
		else if (!isAbsence) saveLump();
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<form class="grid gap-4" onsubmit={onSubmit}>
			<Dialog.Header>
				<Dialog.Title>Schnelleingabe</Dialog.Title>
				<Dialog.Description>Mehrere Tage auf einmal oder eine Pauschalsumme erfassen.</Dialog.Description>
			</Dialog.Header>

			<div class="space-y-3">
				<div class="bg-muted flex gap-1 rounded-md p-1 text-sm">
					<button
						type="button"
						class="flex-1 rounded px-2 py-1 {mode === 'days' ? 'bg-background shadow-sm' : ''}"
						onclick={() => (mode = "days")}
					>
						Mehrere Tage
					</button>
					<button
						type="button"
						class="flex-1 rounded px-2 py-1 {mode === 'lump' ? 'bg-background shadow-sm' : ''}"
						onclick={() => (mode = "lump")}
					>
						Pauschal (Summe)
					</button>
				</div>

			<div class="space-y-1">
				<Label for="bact">Aktivität</Label>
				<select
					id="bact"
					bind:value={activityId}
					class="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
				>
					{#each app.visibleActivities as a (a.id)}
						<option value={a.id}>{a.name}</option>
					{/each}
				</select>
			</div>

			{#if mode === "days"}
				<div class="grid grid-cols-2 gap-2">
					<div class="space-y-1">
						<Label for="von">Von</Label>
						<Input id="von" type="date" bind:value={von} />
					</div>
					<div class="space-y-1">
						<Label for="bis">Bis</Label>
						<Input id="bis" type="date" bind:value={bis} />
					</div>
				</div>
				<div class="flex items-center justify-between">
					<Label for="wd">Nur Werktage (Mo–Fr)</Label>
					<Switch id="wd" checked={onlyWeekdays} onCheckedChange={(v) => (onlyWeekdays = v)} />
				</div>
				{#if isAbsence}
					<div class="space-y-1">
						<Label for="bfrac">Umfang je Tag</Label>
						<select
							id="bfrac"
							bind:value={fraction}
							class="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
						>
							<option value={1}>Ganzer Tag ({fmtHours(app.settings.hoursPerDay)} h)</option>
							<option value={0.5}>Halber Tag ({fmtHours(app.settings.hoursPerDay / 2)} h)</option>
						</select>
					</div>
				{:else}
					<div class="grid grid-cols-2 gap-2">
						<div class="space-y-1">
							<Label for="bstart">Von (Uhrzeit)</Label>
							<Input
								id="bstart"
								type="text"
								inputmode="numeric"
								placeholder="z. B. 0800"
								value={startText}
								oninput={(e) => (startText = e.currentTarget.value)}
								onchange={commitStart}
							/>
						</div>
						<div class="space-y-1">
							<Label for="bend">Bis (Uhrzeit)</Label>
							<Input
								id="bend"
								type="text"
								inputmode="numeric"
								placeholder="z. B. 1600"
								value={endText}
								oninput={(e) => (endText = e.currentTarget.value)}
								onchange={commitEnd}
							/>
						</div>
					</div>
				{/if}
				<Dialog.Footer>
					<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
					<Button type="submit">Anlegen</Button>
				</Dialog.Footer>
			{:else}
				<div class="grid grid-cols-2 gap-2">
					<div class="space-y-1">
						<Label for="ldate">Tag (Buchung)</Label>
						<Input id="ldate" type="date" bind:value={lumpDate} />
					</div>
					<div class="space-y-1">
						<Label for="lhours">Stunden gesamt</Label>
						<Input
							id="lhours"
							type="text"
							inputmode="decimal"
							placeholder="z. B. 8 · 7,5 · 7:30"
							bind:value={lumpHours}
						/>
					</div>
				</div>
				<p class="text-muted-foreground text-xs">
					Legt einen einzelnen Eintrag mit der gesamten Stundenzahl an (z.B. 80 h für ein Projekt im
					Monat). Für Urlaub bitte „Mehrere Tage“ verwenden.
				</p>
				<Dialog.Footer>
					<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
					<Button type="submit" disabled={isAbsence}>Anlegen</Button>
				</Dialog.Footer>
			{/if}
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>
