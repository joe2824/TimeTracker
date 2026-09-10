<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { account } from "$lib/sync/account.svelte";
	import { createSettingsForm } from "$lib/ui/settingsForm.svelte";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import SettingToggle from "$lib/components/shared/SettingToggle.svelte";
	import SettingsCard from "$lib/components/shared/SettingsCard.svelte";
	import { clearTeamDevice } from "$lib/store";
	import { syncTeamActivities } from "$lib/team/activities";
	import { teamJoin } from "$lib/team/state.svelte";
	import { errorText } from "$lib/log";
	import { toast } from "svelte-sonner";
	import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
	import LogOutIcon from "@lucide/svelte/icons/log-out";
	import UsersIcon from "@lucide/svelte/icons/users";

	// ---------- Team-Mitgliedschaft (dieses Gerät ist Mitglied, kein Chef) ----------
	//
	// Aus teamJoin.device gelesen, nicht selbst per onMount geladen: bits-ui
	// baut alle Einstellungs-Tabs beim Start mit auf, ein einmaliges Laden hier
	// sähe einen späteren Beitritt über den Deep-Link-Dialog nie.

	let refreshingTeam = $state(false);

	async function refreshTeamActivities() {
		refreshingTeam = true;
		try {
			await syncTeamActivities();
			toast.success("Team-Aktivitäten aktualisiert.");
		} catch (e) {
			toast.error(`Aktualisieren fehlgeschlagen: ${errorText(e)}`);
		} finally {
			refreshingTeam = false;
		}
	}

	async function leaveTeam() {
		await clearTeamDevice();
		teamJoin.device = null;
		// Löst teamOwned-Zeilen aus der gemeinsamen Verwaltung, behält sie aber
		// (archiviert, mit neuer Id) - ein blosses Entfernen liesse schon
		// erfasste Stunden lautlos aus dem Bericht verschwinden.
		await app.detachTeamActivities();
		toast.success("Team verlassen.");
	}

	const REPORT_KEYS = [
		"bossEmail",
		"senderName",
		"reportSubjectTemplate",
		"statsEnabled",
		"arbzgEnabled",
		"arbzgTrackingHint"
	] as const;

	const BOSS_KEYS = ["bossMode"] as const;

	const { form, save } = createSettingsForm();
	let savedReportAt = $state(0);
	let savedBossAt = $state(0);

	async function saveReport() {
		await save(REPORT_KEYS);
		savedReportAt = Date.now();
		if (form.senderName.trim()) {
			void account.updateDisplayName(form.senderName.trim());
		}
	}

	async function saveBossMode() {
		await save(BOSS_KEYS);
		savedBossAt = Date.now();
	}
</script>

{#if teamJoin.device}
	<SettingsCard title="Team-Mitgliedschaft" description="Die gemeinsamen Aktivitäten kommen von dort.">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex items-center gap-2">
				<UsersIcon class="text-muted-foreground size-4" />
				<span class="font-medium">{teamJoin.device.teamName}</span>
			</div>
			<div class="flex gap-2">
				<Button variant="outline" size="sm" disabled={refreshingTeam} onclick={refreshTeamActivities}>
					<RefreshCwIcon class="size-4" /> Aktualisieren
				</Button>
				<Button variant="ghost" size="sm" onclick={leaveTeam}>
					<LogOutIcon class="size-4" /> Team verlassen
				</Button>
			</div>
		</div>
	</SettingsCard>
{/if}

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

<SettingsCard
	title="Chef-Modus"
	description="Ein eigenes Team anlegen, Mitglieder per Link einladen und sehen, wer seinen Bericht schon gesendet hat."
	savedAt={savedBossAt}
>
	<SettingToggle
		id="bossmode"
		title="Chef-Modus"
		description="Blendet den Tab „Team“ ein."
		bind:checked={form.bossMode}
		onCheckedChange={(v) => {
			form.bossMode = v;
			void saveBossMode();
		}}
	/>
</SettingsCard>

