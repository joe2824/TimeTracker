<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { fmtDate, noonTs, parseClock, parseHours, toTs } from "$lib/time";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import * as Dialog from "$lib/components/ui/dialog";
	import ActivityCombobox from "$lib/components/ActivityCombobox.svelte";
	import WorkdayPicker from "$lib/components/WorkdayPicker.svelte";
	import DateInput from "$lib/components/DateInput.svelte";
	import DayFractionSwitch from "$lib/components/DayFractionSwitch.svelte";
	import { toast } from "svelte-sonner";

	let {
		open = $bindable(false),
		onsaved
	}: { open?: boolean; onsaved: (month?: string) => void } = $props();

	// Keine Vorauswahl – der Nutzer wählt die Aktivität selbst.
	let activityId = $state("");
	const isAbsence = $derived(app.isAbsenceId(activityId));

	let von = $state("");
	let bis = $state("");
	let days = $state<number[]>([...app.settings.workdays]); // gewählte Wochentage (0=So..6=Sa)

	// Zeit ODER pauschal: sind Von/Bis-Uhrzeit gesetzt -> Zeit wird gerechnet;
	// sonst werden die pauschalen Stunden je Tag gebucht.
	let start = $state("08:00");
	let end = $state("16:00");
	let startText = $state("08:00");
	let endText = $state("16:00");
	let lumpHours = $state(""); // pauschale Stunden je Tag (wenn keine Uhrzeit)

	let fraction = $state(1); // nur Abwesenheit

	// Beim Öffnen alles auf Standard: keine Aktivität, Datums-Defaults, Arbeitstage.
	$effect(() => {
		if (!open) return;
		activityId = "";
		von = bis = fmtDate(Date.now()); // Default: heute
		days = [...app.settings.workdays];
		start = startText = "08:00";
		end = endText = "16:00";
		lumpHours = "";
		fraction = 1;
	});

	/** Uhrzeit beim Verlassen normalisieren; leere Eingabe bleibt leer (= pauschal). */
	function commitStart() {
		const t = startText.trim();
		if (t === "") {
			start = startText = "";
			return;
		}
		start = parseClock(t) ?? start;
		startText = start;
	}
	function commitEnd() {
		const t = endText.trim();
		if (t === "") {
			end = endText = "";
			return;
		}
		end = parseClock(t) ?? end;
		endText = end;
	}

	async function save() {
		if (!activityId) {
			toast.error("Bitte eine Aktivität wählen.");
			return;
		}
		commitStart();
		commitEnd();
		const a = new Date(noonTs(von));
		const b = new Date(noonTs(bis));
		if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || a > b) {
			toast.error("Ungültiger Datumsbereich.");
			return;
		}
		if (days.length === 0) {
			toast.error("Bitte mindestens einen Wochentag wählen.");
			return;
		}

		// Zeitmodus, wenn Von UND Bis Uhrzeit gesetzt sind; sonst pauschal.
		const useTimes = !isAbsence && start !== "" && end !== "";
		let lump: number | null = null;
		if (!isAbsence && !useTimes) {
			lump = parseHours(lumpHours);
			if (lump == null || lump <= 0) {
				toast.error("Bitte Von/Bis-Uhrzeit angeben – oder Stunden (pauschal) je Tag.");
				return;
			}
		}

		let count = 0;
		for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
			if (!days.includes(d.getDay())) continue; // nur gewählte Wochentage
			const date = fmtDate(d.getTime());
			if (isAbsence) {
				const ts = noonTs(date);
				if (await app.addEntry(activityId, ts, ts, "", "manual", fraction)) count++;
			} else if (useTimes) {
				let s = toTs(date, start);
				let e = toTs(date, end);
				if (e < s) e += 24 * 3600 * 1000;
				if (await app.addEntry(activityId, s, e, "", "manual")) count++;
			} else {
				const s = toTs(date, "08:00");
				const e = s + (lump as number) * 3600 * 1000;
				if (await app.addEntry(activityId, s, e, "", "manual")) count++;
			}
		}
		toast.success(`${count} Eintrag/Einträge angelegt.`);
		open = false;
		onsaved(von.slice(0, 7)); // auf den Zeitraum-Monat springen
	}

	function onSubmit(e: SubmitEvent) {
		e.preventDefault();
		save();
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<form class="grid gap-4" onsubmit={onSubmit}>
			<Dialog.Header>
				<Dialog.Title>Mehrere Tage</Dialog.Title>
				<Dialog.Description>
					Für jeden gewählten Wochentag im Zeitraum einen Eintrag anlegen – mit Uhrzeit oder pauschal.
				</Dialog.Description>
			</Dialog.Header>

			<div class="space-y-3">
				<div class="space-y-1">
					<Label for="bact">Aktivität</Label>
					<ActivityCombobox id="bact" bind:value={activityId} options={app.visibleActivities} />
				</div>

				<div class="grid grid-cols-2 gap-2">
					<div class="space-y-1">
						<Label for="von">Von</Label>
						<DateInput id="von" bind:value={von} />
					</div>
					<div class="space-y-1">
						<Label for="bis">Bis</Label>
						<DateInput id="bis" bind:value={bis} />
					</div>
				</div>

				<div class="space-y-1">
					<Label>Wochentage</Label>
					<WorkdayPicker bind:value={days} />
					<p class="text-muted-foreground text-xs">
						Nur an diesen Tagen im Zeitraum wird gebucht (Standard: deine Arbeitstage; Sa/So wählbar).
					</p>
				</div>

				{#if isAbsence}
					<DayFractionSwitch id="bfrac" label="Umfang je Tag" bind:value={fraction} />
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
					<div class="space-y-1">
						<Label for="blump">Stunden (pauschal, je Tag)</Label>
						<Input
							id="blump"
							type="text"
							inputmode="decimal"
							placeholder="z. B. 8 · 7,5 · 7:30"
							bind:value={lumpHours}
						/>
						<p class="text-muted-foreground text-xs">
							Mit Von/Bis-Uhrzeit wird die Zeit gerechnet. Lässt du die Uhrzeit leer, werden diese
							Stunden je Tag pauschal gebucht.
						</p>
					</div>
				{/if}
			</div>

			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit">Anlegen</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
