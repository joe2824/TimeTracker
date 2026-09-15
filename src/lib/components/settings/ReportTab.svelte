<script lang="ts">
	import { account } from "$lib/sync/account.svelte";
	import { createSettingsForm } from "$lib/ui/settingsForm.svelte";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import SettingToggle from "$lib/components/shared/SettingToggle.svelte";
	import SettingsCard from "$lib/components/shared/SettingsCard.svelte";

	const REPORT_KEYS = [
		"bossEmail",
		"senderName",
		"reportSubjectTemplate",
		"statsEnabled",
		"arbzgEnabled",
		"arbzgTrackingHint"
	] as const;

	const { form, save } = createSettingsForm();
	let savedReportAt = $state(0);

	async function saveReport() {
		await save(REPORT_KEYS);
		savedReportAt = Date.now();
		if (form.senderName.trim()) {
			void account.updateDisplayName(form.senderName.trim());
		}
	}
</script>

<SettingsCard
	title="Bericht & E-Mail"
	description="Wohin der Monatsbericht geht und wie er betitelt ist."
	savedAt={savedReportAt}
>
	<div class="grid gap-3 sm:grid-cols-2">
		<div class="space-y-1.5 sm:col-span-2">
			<Label for="boss">E-Mail der/des Vorgesetzten</Label>
			<Input
				id="boss"
				type="email"
				bind:value={form.bossEmail}
				placeholder="name@firma.de"
				onchange={saveReport}
			/>
		</div>
		<div class="space-y-1.5">
			<Label for="sender">Dein Name (optional)</Label>
			<Input id="sender" bind:value={form.senderName} onchange={saveReport} />
		</div>
		<div class="space-y-1.5">
			<Label for="subj">Betreff-Vorlage</Label>
			<Input id="subj" bind:value={form.reportSubjectTemplate} onchange={saveReport} />
			<p class="text-muted-foreground text-xs">
				{"{month}"} = Monat, {"{name}"} = dein Name
			</p>
		</div>
	</div>
	<SettingToggle
		id="stats"
		title="Auswertung anzeigen"
		description="Saldo, Stunden je Aktivität und Jahres-Heatmap im Tab „Bericht“. Nur für dich – die E-Mail bleibt unverändert."
		bind:checked={form.statsEnabled}
		onCheckedChange={(v) => {
			form.statsEnabled = v;
			void saveReport();
		}}
	/>
	<SettingToggle
		id="arbzg"
		title="Arbeitszeit-Check anzeigen"
		description="Schätzt nach dem Arbeitszeitgesetz, ob der 24-Wochen-Schnitt von 8 h zu reißen droht, und was sich am Tempo ändern müsste. Nur für dich – die E-Mail bleibt unverändert."
		bind:checked={form.arbzgEnabled}
		onCheckedChange={(v) => {
			form.arbzgEnabled = v;
			void saveReport();
		}}
	/>
	<SettingToggle
		id="arbzghint"
		title="Hinweis beim Tracking"
		description="Zeigt oben auf der Tracking-Seite eine Zeile, wenn der 24-Wochen-Schnitt zu reißen droht. Schweigt, solange alles im grünen Bereich ist."
		bind:checked={form.arbzgTrackingHint}
		onCheckedChange={(v) => {
			form.arbzgTrackingHint = v;
			void saveReport();
		}}
	/>
</SettingsCard>
