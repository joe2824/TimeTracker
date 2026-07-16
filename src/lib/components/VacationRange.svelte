<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { Button } from "$lib/components/ui/button";
	import { Label } from "$lib/components/ui/label";
	import * as Dialog from "$lib/components/ui/dialog";
	import DateInput from "$lib/components/DateInput.svelte";
	import DayFractionSwitch from "$lib/components/DayFractionSwitch.svelte";
	import { toast } from "svelte-sonner";
	import { fmtDate } from "$lib/time";

	let { open = $bindable(false), onsaved }: { open?: boolean; onsaved?: (month?: string) => void } =
		$props();

	let from = $state(fmtDate(Date.now()));
	let to = $state(fmtDate(Date.now()));
	// Tagesanteil statt Boolean: dieselbe Groesse, die addAbsenceRange und die
	// anderen Dialoge verwenden – kein Umrechnen an der Grenze mehr.
	let fraction = $state(1);

	async function add() {
		const { added, skipped } = await app.addAbsenceRange(from, to, fraction);
		if (added > 0) {
			const extra = skipped > 0 ? ` (${skipped} mit Projektzeit übersprungen)` : "";
			toast.success(`${added} Abwesenheitstag(e) eingetragen${extra}.`);
			onsaved?.(from.slice(0, 7)); // auf den Abwesenheits-Monat springen
			open = false;
		} else if (skipped > 0) {
			toast.error(`${skipped} Tag(e) haben Projektzeiten – nur halber Urlaubstag möglich.`);
		} else {
			toast.error("Kein Tag eingetragen – Zeitraum prüfen.");
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<form class="grid gap-4" onsubmit={(e) => { e.preventDefault(); add(); }}>
			<Dialog.Header>
				<Dialog.Title>Urlaub / Abwesenheit (Zeitraum)</Dialog.Title>
				<Dialog.Description>
					Trägt für jeden <strong>Arbeitstag</strong> im Bereich einen Abwesenheitseintrag an
					(Wochenenden/freie Tage werden übersprungen).
				</Dialog.Description>
			</Dialog.Header>
			<div class="space-y-4">
				<div class="flex flex-wrap items-end gap-4">
					<div class="space-y-1">
						<Label for="vacfrom">Von</Label>
						<DateInput id="vacfrom" bind:value={from} class="w-40" />
					</div>
					<div class="space-y-1">
						<Label for="vacto">Bis</Label>
						<DateInput id="vacto" bind:value={to} class="w-40" />
					</div>
				</div>
				<DayFractionSwitch id="vacfrac" label="Umfang je Tag" bind:value={fraction} />
			</div>
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit">Eintragen</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
