<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { fmtDate, fmtHours, parseClock, parseHours } from "$lib/time";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Switch } from "$lib/components/ui/switch";
	import * as Dialog from "$lib/components/ui/dialog";
	import ActivityCombobox from "$lib/components/ActivityCombobox.svelte";
	import WorkdayPicker from "$lib/components/WorkdayPicker.svelte";
	import { toast } from "svelte-sonner";

	let {
		open = $bindable(false),
		month,
		onsaved
	}: { open?: boolean; month: string; onsaved: () => void } = $props();

	// Keine Vorauswahl – der Nutzer wählt die Aktivität selbst.
	let activityId = $state("");
	const isAbsence = $derived(app.isAbsenceId(activityId));

	// false = Zeitraum (Von–Bis), true = Pauschalsumme auf einen Tag (nur Nicht-Abwesenheit).
	let lump = $state(false);

	// Zeitraum
	let von = $state("");
	let bis = $state("");
	let days = $state<number[]>([...app.settings.workdays]); // gewählte Wochentage (0=So..6=Sa)
	let start = $state("08:00");
	let end = $state("16:00");
	let startText = $state("08:00");
	let endText = $state("16:00");
	let fraction = $state(1);

	// Pauschal
	let lumpDate = $state("");
	let lumpHours = $state("8");

	// Beim Öffnen: Datums-Defaults auf den gewählten Monat, Tage auf die Arbeitstage.
	$effect(() => {
		if (!open) return;
		von = `${month}-01`;
		bis = `${month}-01`;
		lumpDate = `${month}-01`;
		days = [...app.settings.workdays];
	});

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

	function toTs(date: string, time: string): number {
		return new Date(`${date}T${time}:00`).getTime();
	}

	async function saveRange() {
		if (!activityId) {
			toast.error("Bitte eine Aktivität wählen.");
			return;
		}
		commitStart();
		commitEnd();
		const a = new Date(`${von}T12:00:00`);
		const b = new Date(`${bis}T12:00:00`);
		if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || a > b) {
			toast.error("Ungültiger Datumsbereich.");
			return;
		}
		if (days.length === 0) {
			toast.error("Bitte mindestens einen Wochentag wählen.");
			return;
		}
		let count = 0;
		for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
			if (!days.includes(d.getDay())) continue; // nur gewählte Wochentage
			const date = fmtDate(d.getTime());
			if (isAbsence) {
				const ts = toTs(date, "12:00");
				if (await app.addEntry(activityId, ts, ts, "", "manual", fraction)) count++;
			} else {
				let s = toTs(date, start);
				let e = toTs(date, end);
				if (e < s) e += 24 * 3600 * 1000;
				if (await app.addEntry(activityId, s, e, "", "manual")) count++;
			}
		}
		toast.success(`${count} Eintrag/Einträge angelegt.`);
		open = false;
		onsaved();
	}

	async function saveLump() {
		if (!activityId) {
			toast.error("Bitte eine Aktivität wählen.");
			return;
		}
		const hours = parseHours(lumpHours);
		if (hours == null || hours <= 0) {
			toast.error("Bitte gültige Stundenzahl angeben.");
			return;
		}
		const s = toTs(lumpDate, "08:00");
		const e = s + hours * 3600 * 1000;
		if (await app.addEntry(activityId, s, e, "Pauschaleintrag", "manual")) {
			toast.success(`${fmtHours(hours)} h angelegt.`);
			open = false;
			onsaved();
		}
	}

	function onSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (lump && !isAbsence) saveLump();
		else saveRange();
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<form class="grid gap-4" onsubmit={onSubmit}>
			<Dialog.Header>
				<Dialog.Title>Schnelleingabe</Dialog.Title>
				<Dialog.Description>
					Mehrere Tage eines Zeitraums auf einmal – oder eine Pauschalsumme auf einen Tag.
				</Dialog.Description>
			</Dialog.Header>

			<div class="space-y-3">
				<div class="space-y-1">
					<Label for="bact">Aktivität</Label>
					<ActivityCombobox id="bact" bind:value={activityId} options={app.visibleActivities} />
				</div>

				{#if !isAbsence}
					<label class="flex items-center justify-between gap-2 text-sm">
						<span>
							Pauschalsumme
							<span class="text-muted-foreground text-xs">(eine Summe auf einen Tag)</span>
						</span>
						<Switch bind:checked={lump} />
					</label>
				{/if}

				{#if lump && !isAbsence}
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
						Legt einen einzelnen Eintrag mit der gesamten Stundenzahl an (z. B. 80 h für ein Projekt
						im Monat).
					</p>
				{:else}
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
					<div class="space-y-1">
						<Label>Wochentage</Label>
						<WorkdayPicker bind:value={days} />
						<p class="text-muted-foreground text-xs">
							Nur an diesen Tagen im Zeitraum wird gebucht (Standard: deine Arbeitstage; Sa/So
							wählbar).
						</p>
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
				{/if}
			</div>

			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit">Anlegen</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
