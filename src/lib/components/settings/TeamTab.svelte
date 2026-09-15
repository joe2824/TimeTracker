<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { account } from "$lib/sync/account.svelte";
	import { chefTeams } from "$lib/team/chef.svelte";
	import type { TeamInfo } from "$lib/sync/api";
	import { createSettingsForm } from "$lib/ui/settingsForm.svelte";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import * as Select from "$lib/components/ui/select";
	import * as Dialog from "$lib/components/ui/dialog";
	import SettingToggle from "$lib/components/shared/SettingToggle.svelte";
	import SettingsCard from "$lib/components/shared/SettingsCard.svelte";
	import { clearTeamDevice } from "$lib/store";
	import { syncTeamActivities } from "$lib/team/activities";
	import { teamJoin } from "$lib/team/state.svelte";
	import { errorText } from "$lib/log";
	import { tabFocus } from "$lib/ui/tabFocus.svelte";
	import { toast } from "svelte-sonner";
	import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
	import LogOutIcon from "@lucide/svelte/icons/log-out";
	import UsersIcon from "@lucide/svelte/icons/users";
	import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
	import PlusIcon from "@lucide/svelte/icons/plus";
	import CopyIcon from "@lucide/svelte/icons/copy";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";

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

	// ---------- Chef-Modus ----------

	const BOSS_KEYS = ["bossMode"] as const;
	const { form, save } = createSettingsForm();
	let savedBossAt = $state(0);

	async function saveBossMode() {
		await save(BOSS_KEYS);
		savedBossAt = Date.now();
	}

	// ---------- Team anlegen und Beitritts-Link ----------
	//
	// Geteilter Zustand mit dem Team-Tab (chefTeams): wer hier ein Team anlegt
	// oder den Link erneuert, sieht es dort sofort - und umgekehrt.

	$effect(() => {
		if (form.bossMode && account.linked) void chefTeams.loadTeams();
	});
	$effect(() => {
		if (form.bossMode && chefTeams.selectedTeamId) void chefTeams.loadInvite(chefTeams.selectedTeamId);
	});

	let newTeamName = $state("");

	async function createTeam() {
		const name = newTeamName.trim();
		if (!name || chefTeams.creating) return;
		try {
			await chefTeams.createTeam(name);
			newTeamName = "";
			toast.success(`Team „${name}" angelegt.`);
		} catch (e) {
			toast.error(`Team konnte nicht angelegt werden: ${errorText(e)}`);
		}
	}

	async function rotateInvite() {
		try {
			await chefTeams.rotateInvite();
		} catch (e) {
			toast.error(`Link konnte nicht erzeugt werden: ${errorText(e)}`);
		}
	}

	// Löschen ist endgültig (Mitglieder, Aktivitäten, Berichte - alles gebunden
	// an dieses Team - gehen mit) - deshalb ein eigener Bestätigungsdialog statt
	// eines blossen Knopfdrucks.
	let deleteTarget = $state<TeamInfo | null>(null);
	let deleting = $state(false);

	async function confirmDeleteTeam() {
		if (!deleteTarget) return;
		deleting = true;
		try {
			const name = deleteTarget.name;
			await chefTeams.deleteTeam(deleteTarget.id);
			toast.success(`Team „${name}" gelöscht.`);
			deleteTarget = null;
		} catch (e) {
			toast.error(`Team konnte nicht gelöscht werden: ${errorText(e)}`);
		} finally {
			deleting = false;
		}
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
	{#if form.bossMode}
		<Button variant="link" class="h-auto p-0" onclick={() => tabFocus.request("team")}>
			Zum Team-Tab <ArrowRightIcon class="size-4" />
		</Button>
	{/if}
</SettingsCard>

{#if form.bossMode && !account.linked}
	<SettingsCard title="Team anlegen" description="Braucht ein Konto - Team und Beitritts-Link liegen dort, nicht nur auf diesem Gerät.">
		<Button variant="link" class="h-auto p-0" onclick={() => tabFocus.requestSettings("konto")}>
			Zu den Konto-Einstellungen
		</Button>
	</SettingsCard>
{:else if form.bossMode}
	<SettingsCard title="Team anlegen und Beitritts-Link" divided={false}>
		<div class="space-y-1.5">
			<Label for="newteam">Neues Team</Label>
			<div class="flex gap-2">
				<Input
					id="newteam"
					bind:value={newTeamName}
					placeholder="z.B. „Vertrieb“"
					onkeydown={(e) => e.key === "Enter" && createTeam()}
				/>
				<Button variant="outline" disabled={!newTeamName.trim() || chefTeams.creating} onclick={createTeam}>
					<PlusIcon class="size-4" /> Anlegen
				</Button>
			</div>
		</div>

		{#if chefTeams.teams.length > 0}
			<div class="space-y-1.5">
				<Label for="teampick">{chefTeams.teams.length > 1 ? "Team" : "Ausgewähltes Team"}</Label>
				<div class="flex items-center gap-2">
					{#if chefTeams.teams.length > 1}
						<Select.Root type="single" bind:value={chefTeams.selectedTeamId}>
							<Select.Trigger id="teampick" class="w-56">
								{chefTeams.selectedTeam?.name ?? "Team wählen"}
							</Select.Trigger>
							<Select.Content>
								{#each chefTeams.teams as t (t.id)}
									<Select.Item value={t.id} label={t.name}>{t.name}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					{:else}
						<span class="text-sm font-medium">{chefTeams.selectedTeam?.name}</span>
					{/if}
					{#if chefTeams.selectedTeam}
						<Button
							variant="ghost"
							size="icon-sm"
							title="Team endgültig löschen"
							onclick={() => (deleteTarget = chefTeams.selectedTeam)}
						>
							<Trash2Icon class="text-destructive size-4" />
						</Button>
					{/if}
				</div>
			</div>

			<div class="space-y-1.5">
				<Label>Beitritts-Link</Label>
				{#if chefTeams.inviteLoading}
					<p class="text-muted-foreground text-sm">Wird geladen…</p>
				{:else}
					<div class="flex flex-wrap items-center gap-2">
						{#if chefTeams.inviteUrl}
							<code class="bg-muted rounded px-2 py-1 text-xs break-all">{chefTeams.inviteUrl}</code>
							<Button variant="ghost" size="icon-sm" title="Link kopieren" onclick={() => chefTeams.copyInviteUrl()}>
								<CopyIcon class="size-4" />
							</Button>
						{/if}
						<Button variant="outline" size="sm" disabled={chefTeams.rotating} onclick={rotateInvite}>
							<RefreshCwIcon class="size-4" />
							{chefTeams.invite ? "Neuen Link erzeugen" : "Link erzeugen"}
						</Button>
					</div>
					<p class="text-muted-foreground text-xs">
						Ein neuer Link macht den bisherigen ungültig - schon beigetretene Mitglieder bleiben davon
						unberührt.
					</p>
				{/if}
			</div>
		{/if}
	</SettingsCard>

	<Dialog.Root open={!!deleteTarget} onOpenChange={(v) => { if (!v && !deleting) deleteTarget = null; }}>
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title>„{deleteTarget?.name}" endgültig löschen?</Dialog.Title>
				<Dialog.Description>
					Mitglieder, gemeinsame Aktivitäten und alle gesendeten Berichte dieses Teams gehen damit
					unwiderruflich verloren. Der Beitritts-Link wird ungültig. Zeiten, die Mitglieder bereits
					erfasst hatten, bleiben auf deren eigenen Geräten erhalten.
				</Dialog.Description>
			</Dialog.Header>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (deleteTarget = null)} disabled={deleting}>
					Abbrechen
				</Button>
				<Button type="button" variant="destructive" onclick={confirmDeleteTeam} disabled={deleting}>
					<Trash2Icon class="size-4" />
					{deleting ? "Wird gelöscht…" : "Endgültig löschen"}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
{/if}
