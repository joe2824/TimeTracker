<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { account } from "$lib/sync/account.svelte";
	import { formFromSettings, patchFrom, syncForm } from "$lib/settingsSync";
	import type { Settings } from "$lib/types";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import SettingToggle from "$lib/components/SettingToggle.svelte";
	import SettingsCard from "$lib/components/SettingsCard.svelte";
	import { capabilities } from "$lib/platform/env";
	import PlusIcon from "@lucide/svelte/icons/plus";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";

	const REPORT_KEYS = [
		"bossEmail",
		"senderName",
		"reportSubjectTemplate",
		"statsEnabled",
		"arbzgEnabled",
		"arbzgTrackingHint"
	] as const;

	const BOSS_KEYS = ["bossMode", "team", "teamSubjectFilter", "teamScanSubfolders"] as const;

	function getCurrentSettings(): Settings {
		return $state.snapshot(app.settings) as Settings;
	}

	let form = $state(formFromSettings(getCurrentSettings()));
	let synced = getCurrentSettings();
	let savedReportAt = $state(0);
	let savedBossAt = $state(0);

	$effect(() => {
		synced = syncForm(form, synced, getCurrentSettings());
	});

	async function saveFields(keys: readonly (keyof Settings)[]): Promise<void> {
		await app.updateSettings(patchFrom(form, keys, getCurrentSettings()));
	}

	async function saveReport() {
		await saveFields(REPORT_KEYS);
		savedReportAt = Date.now();
		if (form.senderName.trim()) {
			void account.updateDisplayName(form.senderName.trim());
		}
	}

	async function saveBossMode() {
		await saveFields(BOSS_KEYS);
		savedBossAt = Date.now();
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
		onCheckedChange={() => saveReport()}
	/>
	<SettingToggle
		id="arbzg"
		title="Arbeitszeit-Check anzeigen"
		description="Schätzt nach dem Arbeitszeitgesetz, ob der 24-Wochen-Schnitt von 8 h zu reißen droht, und was sich am Tempo ändern müsste. Nur für dich – die E-Mail bleibt unverändert."
		bind:checked={form.arbzgEnabled}
		onCheckedChange={() => saveReport()}
	/>
	<SettingToggle
		id="arbzghint"
		title="Hinweis beim Tracking"
		description="Zeigt oben auf der Tracking-Seite eine Zeile, wenn der 24-Wochen-Schnitt zu reißen droht. Schweigt, solange alles im grünen Bereich ist."
		bind:checked={form.arbzgTrackingHint}
		onCheckedChange={() => saveReport()}
	/>
</SettingsCard>

{#if capabilities.outlook}
	<SettingsCard
		title="Chef-Modus"
		description="Prüft im Outlook-Posteingang, wer seinen Monatsbericht geschickt hat und wer nicht."
		savedAt={savedBossAt}
	>
		<SettingToggle
			id="bossmode"
			title="Chef-Modus"
			description="Blendet den Tab „Team“ ein. Es wird ausschließlich gelesen – keine Mail wird verschoben oder markiert."
			bind:checked={form.bossMode}
			onCheckedChange={() => saveBossMode()}
		/>

		{#if form.bossMode}
			<div class="space-y-2">
				<Label>Team</Label>
				<p class="text-muted-foreground text-xs leading-relaxed">
					Von wem monatlich ein Bericht erwartet wird. Die Zuordnung läuft über die E-Mail-Adresse
					– fehlt jemand hier, taucht sein Bericht trotzdem auf, nur eben ohne „fehlt“-Abgleich.
				</p>
				{#each form.team as m, i (m.id)}
					<div class="flex gap-2">
						<Input placeholder="Name" bind:value={form.team[i].name} onchange={saveBossMode} />
						<Input
							type="email"
							placeholder="name@firma.de"
							bind:value={form.team[i].email}
							onchange={saveBossMode}
						/>
						<Button
							variant="ghost"
							size="icon"
							title="Aus dem Team entfernen"
							onclick={() => {
								form.team = form.team.filter((_, j) => j !== i);
								void saveBossMode();
							}}
						>
							<Trash2Icon class="size-4" />
						</Button>
					</div>
				{/each}
				<Button
					variant="outline"
					size="sm"
					onclick={() =>
						(form.team = [...form.team, { id: crypto.randomUUID(), name: "", email: "" }])}
				>
					<PlusIcon class="size-4" /> Mitarbeiter
				</Button>
			</div>

			<div class="space-y-1.5">
				<Label for="tsubj">Betreff enthält</Label>
				<Input id="tsubj" bind:value={form.teamSubjectFilter} onchange={saveBossMode} />
				<p class="text-muted-foreground text-xs leading-relaxed">
					Nur Mails mit diesem Text im Betreff werden gelesen. Standard ist der Anfang der
					Betreff-Vorlage, die TimeTracker selbst verschickt.
				</p>
			</div>

			<SettingToggle
				id="tsubf"
				title="Unterordner mitlesen"
				description="Auch Unterordner des Posteingangs durchsuchen – für alle, die Berichte per Regel einsortieren lassen."
				bind:checked={form.teamScanSubfolders}
				onCheckedChange={() => saveBossMode()}
			/>
		{/if}
	</SettingsCard>
{/if}

