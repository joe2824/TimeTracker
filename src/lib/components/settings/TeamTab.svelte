<script lang="ts">
	import ConfirmDialog from "$lib/components/shared/ConfirmDialog.svelte";
	import { app } from "$lib/app.svelte";
	import { account } from "$lib/sync/account.svelte";
	import { managedTeams } from "$lib/team/managedTeams.svelte";
	import type { TeamInfo } from "$lib/sync/api";
	import { fmtDateHuman } from "$lib/time/time";
	import { createSettingsForm } from "$lib/ui/settingsForm.svelte";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import * as Select from "$lib/components/ui/select";
	import * as Dialog from "$lib/components/ui/dialog";
	import { Switch } from "$lib/components/ui/switch";
	import { Checkbox } from "$lib/components/ui/checkbox";
	import SettingsCard from "$lib/components/shared/SettingsCard.svelte";
	import InviteLinkField from "$lib/components/team/InviteLinkField.svelte";
	import {
		dismissTeamRemoved,
		isJoinedTeamRow,
		leaveTeam as leaveJoinedTeam,
		syncOwnedTeamActivities,
		syncTeamActivities
	} from "$lib/team/activities";
	import { teamJoin } from "$lib/team/state.svelte";
	import { errorText } from "$lib/log";
	import { tabFocus } from "$lib/ui/tabFocus.svelte";
	import { cn } from "$lib/utils";
	import { toast } from "svelte-sonner";
	import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
	import LogOutIcon from "@lucide/svelte/icons/log-out";
	import UsersIcon from "@lucide/svelte/icons/users";
	import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
	import PlusIcon from "@lucide/svelte/icons/plus";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";
	import ArrowLeftRightIcon from "@lucide/svelte/icons/arrow-left-right";
	import CloudIcon from "@lucide/svelte/icons/cloud";
	import ShieldIcon from "@lucide/svelte/icons/shield";
	import XIcon from "@lucide/svelte/icons/x";
	import CheckIcon from "@lucide/svelte/icons/check";

	// ---------- Team-Mitgliedschaft (dieses Gerät ist Mitglied, keine Leitung) ----------
	//
	// Aus teamJoin.device gelesen, nicht selbst per onMount geladen: bits-ui
	// baut alle Einstellungs-Tabs beim Start mit auf, ein einmaliges Laden hier
	// sähe einen späteren Beitritt über den Deep-Link-Dialog nie.

	let refreshingTeam = $state(false);

	async function refreshTeamActivities() {
		refreshingTeam = true;
		try {
			const result = await syncTeamActivities();
			if (result === "ok") toast.success("Team-Aktivitäten aktualisiert.");
			else if (result === "offline") toast.error("Keine Verbindung – bitte später erneut versuchen.");
		} catch (e) {
			toast.error(`Aktualisieren fehlgeschlagen: ${errorText(e)}`);
		} finally {
			refreshingTeam = false;
		}
	}

	let confirmLeave = $state(false);
	/** Die Team-Aktivitäten, die nach dem Austritt als eigene weiterlaufen sollen. */
	let keepIds = $state<ReadonlySet<string>>(new Set());
	const joinedRows = $derived(app.activities.filter((a) => isJoinedTeamRow(a) && !a.archived));

	async function askLeave() {
		keepIds = new Set();
		confirmLeave = true;
		// Vorschlag: was man benutzt hat, läuft weiter. Scheitert das Nachsehen,
		// bleibt die Auswahl leer - gefragt wird trotzdem.
		try {
			const used = await app.activityIdsInUse();
			keepIds = new Set(joinedRows.filter((a) => used.has(a.id)).map((a) => a.id));
		} catch {
			// Die Auswahl bleibt, wie sie ist.
		}
	}

	function toggleKeep(id: string, checked: boolean) {
		const next = new Set(keepIds);
		if (checked) next.add(id);
		else next.delete(id);
		keepIds = next;
	}

	async function leaveTeam() {
		try {
			await leaveJoinedTeam(keepIds);
			confirmLeave = false;
			toast.success("Team verlassen. Deine erfassten Zeiten bleiben erhalten.");
		} catch (e) {
			toast.error(`Team verlassen fehlgeschlagen: ${errorText(e)}`);
		}
	}

	// ---------- Vorgesetzten-Modus ----------

	const BOSS_KEYS = ["bossMode"] as const;
	const { form, save } = createSettingsForm();
	let savedBossAt = $state(0);

	async function saveBossMode() {
		await save(BOSS_KEYS);
		savedBossAt = Date.now();
	}

	// ---------- Team anlegen und Beitritts-Link ----------
	//
	// Geteilter Zustand mit dem Team-Tab (managedTeams): wer hier ein Team anlegt
	// oder den Link erneuert, sieht es dort sofort - und umgekehrt.

	$effect(() => {
		if (form.bossMode && account.linked) void managedTeams.loadTeams();
	});
	$effect(() => {
		const teamId = managedTeams.selectedTeamId;
		if (!form.bossMode || !teamId) return;
		// Fehlt der Link noch (frisch angelegtes Team), gleich erzeugen statt die
		// Leitung erst auf "Link erzeugen" klicken zu lassen.
		void managedTeams.loadInvite(teamId).then((ok) => {
			if (ok && teamId === managedTeams.selectedTeamId && !managedTeams.invite && managedTeams.isOwner) {
				void rotateInvite();
			}
		});
		void managedTeams.loadAdmins(teamId);
		if (managedTeams.isOwner) void managedTeams.loadAdminInvite(teamId);
	});

	let newTeamName = $state("");
	// Nur beim ersten Team immer sichtbar - sobald eines existiert, verschwindet
	// das Formular hinter "Weiteres Team anlegen", damit die Karte nicht
	// dauerhaft ein Eingabefeld zeigt, das die meisten nie ein zweites Mal brauchen.
	let addingTeam = $state(false);

	async function createTeam() {
		const name = newTeamName.trim();
		if (!name || managedTeams.creating) return;
		try {
			await managedTeams.createTeam(name);
			newTeamName = "";
			addingTeam = false;
			toast.success(`Team „${name}“ angelegt.`);
		} catch (e) {
			toast.error(`Team konnte nicht angelegt werden: ${errorText(e)}`);
		}
	}

	async function rotateInvite() {
		try {
			await managedTeams.rotateInvite();
		} catch (e) {
			toast.error(`Link konnte nicht erzeugt werden: ${errorText(e)}`);
		}
	}

	// ---------- Verwalter ----------

	async function rotateAdminInvite() {
		try {
			await managedTeams.rotateAdminInvite();
		} catch (e) {
			toast.error(`Verwalter-Link konnte nicht erzeugt werden: ${errorText(e)}`);
		}
	}

	async function removeAdmin(userId: string, name: string) {
		try {
			await managedTeams.removeAdmin(userId);
			toast.success(`„${name}“ ist nicht mehr Verwalter.`);
		} catch (e) {
			toast.error(`Entfernen fehlgeschlagen: ${errorText(e)}`);
		}
	}

	// Auswahl per Dropdown, Bestaetigung per Dialog: uebergibt die Leitung
	// versehentlich an die falsche Person, ist das nur durch die neue Leitung
	// rueckgaengig zu machen, nicht mehr von hier aus.
	let transferPickId = $state<string | undefined>(undefined);
	const transferTarget = $derived(
		managedTeams.admins.find((a) => a.userId === transferPickId) ?? null
	);
	let confirmingTransfer = $state(false);
	// Eigener Stand statt live aus managedTeams.admins gelesen: transferOwnership()
	// leert admins/adminInvite noch waehrend die Bestaetigung laeuft (die Rolle
	// wechselt serverseitig sofort) - ein Dialog, der auf diesen Stand angewiesen
	// waere, verlöre seinen Titel oder wuerde durch ein umschliessendes
	// {#if admins.length > 0} mittendrin unmontiert.
	let transferTargetName = $state<string | null>(null);

	function startTransfer() {
		if (!transferTarget) return;
		transferTargetName = transferTarget.displayName;
		confirmingTransfer = true;
	}

	async function confirmTransfer() {
		if (!transferTarget) return;
		try {
			const userId = transferTarget.userId;
			await managedTeams.transferOwnership(userId);
			toast.success(`„${transferTargetName}“ leitet jetzt dieses Team.`);
			confirmingTransfer = false;
			transferPickId = undefined;
		} catch (e) {
			toast.error(`Übergabe fehlgeschlagen: ${errorText(e)}`);
		}
	}

	// Löschen ist endgültig (Mitglieder, Aktivitäten, Berichte - alles gebunden
	// an dieses Team - gehen mit) - deshalb ein eigener Bestätigungsdialog statt
	// eines blossen Knopfdrucks.
	let deleteTarget = $state<TeamInfo | null>(null);

	// Name festhalten: leaveAsAdmin() nimmt das Team noch während der Bestätigung aus der Liste.
	let leaveAdminTeamName = $state<string | null>(null);

	async function confirmLeaveAdmin() {
		try {
			await managedTeams.leaveAsAdmin();
			void syncOwnedTeamActivities();
			toast.success(`Du verwaltest „${leaveAdminTeamName}“ nicht mehr.`);
			leaveAdminTeamName = null;
		} catch (e) {
			toast.error(`Verwaltung abgeben fehlgeschlagen: ${errorText(e)}`);
		}
	}

	async function confirmDeleteTeam() {
		if (!deleteTarget) return;
		try {
			const name = deleteTarget.name;
			await managedTeams.deleteTeam(deleteTarget.id);
			// deleteTeam() raeumt nur managedTeams.teams auf - die Spiegelung in
			// app.activities (Auswahl, Bericht, Timer) haengt sonst bis zum
			// naechsten App-Start oder Aktivitaeten-Tab-Besuch als "teamOwned" fest.
			void syncOwnedTeamActivities();
			toast.success(`Team „${name}“ gelöscht.`);
			deleteTarget = null;
		} catch (e) {
			toast.error(`Team konnte nicht gelöscht werden: ${errorText(e)}`);
		}
	}
</script>

{#if teamJoin.removedFrom && !teamJoin.device}
	<SettingsCard title="Team-Mitgliedschaft" divided={false}>
		<div class="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5">
			<p class="min-w-0 flex-1 text-sm">
				Du bist nicht mehr im Team „{teamJoin.removedFrom}“. Deine erfassten Zeiten bleiben erhalten; die
				Team-Aktivitäten stehen jetzt archiviert bei deinen eigenen.
			</p>
			<Button variant="ghost" size="sm" onclick={() => void dismissTeamRemoved()}>Verstanden</Button>
		</div>
	</SettingsCard>
{/if}

{#if teamJoin.device}
	<SettingsCard
		title="Team-Mitgliedschaft"
		description="Die gemeinsamen Aktivitäten kommen von dort. Wenn du deinen Monatsbericht sendest, sehen Vorgesetzte und Verwalter des Teams deine Stunden je Aktivität."
	>
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex items-center gap-2">
				<UsersIcon class="text-muted-foreground size-4" />
				<span class="font-medium">{teamJoin.device.teamName}</span>
			</div>
			<div class="flex gap-2">
				<Button variant="outline" size="sm" disabled={refreshingTeam} onclick={refreshTeamActivities}>
					<RefreshCwIcon class="size-4" /> Aktualisieren
				</Button>
				<Button variant="ghost" size="sm" onclick={askLeave}>
					<LogOutIcon class="size-4" /> Team verlassen
				</Button>
			</div>
		</div>
	</SettingsCard>
{/if}

<ConfirmDialog
	open={confirmLeave}
	class="sm:max-w-md"
	title={`Team „${teamJoin.device?.teamName}“ verlassen?`}
	description="Deine erfassten Zeiten bleiben erhalten. Deine Berichte gehen danach nicht mehr an das Team. Um wieder beizutreten, brauchst du erneut den Beitritts-Link."
	confirmLabel="Team verlassen"
	busyLabel="Wird verlassen…"
	onConfirm={leaveTeam}
	onClose={() => (confirmLeave = false)}
>
	{#if joinedRows.length > 0}
		<div class="space-y-2">
			<p class="text-sm font-medium">Welche Team-Aktivitäten möchtest du als eigene Aktivitäten weiterführen?</p>
			<p class="text-muted-foreground text-xs">Die übrigen werden archiviert. Ihre Zeiten bleiben im Bericht.</p>
			<div class="max-h-56 space-y-1.5 overflow-y-auto pr-1">
				{#each joinedRows as a (a.id)}
					<div class="flex items-center gap-3 rounded-md border px-3 py-2">
						<Checkbox
							id={`keep-${a.id}`}
							checked={keepIds.has(a.id)}
							onCheckedChange={(v) => toggleKeep(a.id, v === true)}
						/>
						<Label for={`keep-${a.id}`} class="min-w-0 flex-1 cursor-pointer truncate font-normal">{a.name}</Label>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</ConfirmDialog>

<SettingsCard title="Vorgesetzten-Modus" savedAt={savedBossAt} divided={false}>
	{#snippet action()}
		<Label for="bossmode" class="text-muted-foreground text-sm font-normal">Team-Tab anzeigen</Label>
		<Switch
			id="bossmode"
			checked={form.bossMode}
			onCheckedChange={(v) => {
				form.bossMode = v;
				void saveBossMode();
			}}
		/>
	{/snippet}
	{#if form.bossMode}
		<Button variant="link" class="h-auto p-0" onclick={() => tabFocus.request("team")}>
			Zum Team-Tab <ArrowRightIcon class="size-4" />
		</Button>
	{/if}
</SettingsCard>

{#if form.bossMode && !account.linked}
	<SettingsCard title="Team anlegen" divided={false}>
		<div class="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/20 p-3.5">
			<div class="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-md">
				<CloudIcon class="size-4" />
			</div>
			<p class="text-muted-foreground min-w-0 flex-1 text-xs">
				Für ein Team brauchst du ein Konto – dort werden Team und Beitritts-Link gespeichert.
			</p>
			<Button size="sm" class="shrink-0" onclick={() => tabFocus.requestSettings("konto")}>
				Zu den Konto-Einstellungen
			</Button>
		</div>
	</SettingsCard>
{:else if form.bossMode && managedTeams.teamsLoading && managedTeams.teams.length === 0}
	<SettingsCard title="Team anlegen" divided={false}>
		<p class="text-muted-foreground text-sm">Wird geladen…</p>
	</SettingsCard>
{:else if form.bossMode && managedTeams.teamsLoadFailed && managedTeams.teams.length === 0}
	<!-- Nicht "Team anlegen" anbieten: sonst entstünde neben dem nur nicht
	     geladenen Team ein zweites. -->
	<SettingsCard title="Team" divided={false}>
		<div class="flex flex-wrap items-center gap-3 rounded-lg border border-dashed p-3.5">
			<p class="text-muted-foreground min-w-0 flex-1 text-xs">
				Teams konnten gerade nicht geladen werden. Vermutlich besteht keine Internetverbindung.
			</p>
			<Button variant="outline" size="sm" onclick={() => void managedTeams.loadTeams()}>
				<RefreshCwIcon class="size-4" /> Erneut versuchen
			</Button>
		</div>
	</SettingsCard>
{:else if form.bossMode && managedTeams.teams.length === 0}
	<SettingsCard title="Team anlegen" divided={false}>
		<div class="space-y-1.5">
			<Label for="newteam">Name des Teams</Label>
			<div class="flex gap-2">
				<Input
					id="newteam"
					bind:value={newTeamName}
					placeholder="z.B. „Vertrieb“"
					onkeydown={(e) => e.key === "Enter" && createTeam()}
				/>
				<Button variant="outline" disabled={!newTeamName.trim() || managedTeams.creating} onclick={createTeam}>
					<PlusIcon class="size-4" /> Anlegen
				</Button>
			</div>
		</div>
	</SettingsCard>
{:else if form.bossMode}
	<SettingsCard title="Team" description="Beitritts-Link zum Einladen von Mitgliedern." divided={false}>
		{#if managedTeams.teams.length > 1}
			<div class="grid gap-1.5">
				{#each managedTeams.teams as t (t.id)}
					{@const active = t.id === managedTeams.selectedTeamId}
					<button
						type="button"
						aria-pressed={active}
						onclick={() => (managedTeams.selectedTeamId = t.id)}
						class={cn(
							"flex items-center gap-2.5 rounded-lg border p-2.5 text-left text-sm transition-colors",
							active ? "border-primary/40 bg-primary/5 font-medium" : "bg-card/60 hover:bg-card"
						)}
					>
						<UsersIcon class="text-muted-foreground size-4 shrink-0" />
						<span class="min-w-0 flex-1 truncate">{t.name}</span>
						{#if active}
							<CheckIcon class="text-primary size-4 shrink-0" />
						{/if}
					</button>
				{/each}
			</div>
		{/if}

		<div class="flex items-center gap-2">
			{#if managedTeams.teams.length <= 1}
				<span class="text-sm font-medium">{managedTeams.selectedTeam?.name}</span>
			{/if}
			{#if managedTeams.selectedTeam && !managedTeams.isOwner}
				<span class="text-muted-foreground text-xs">(du bist Verwalter, leitest das Team aber nicht)</span>
				<Button
					variant="ghost"
					size="sm"
					class="ml-auto"
					onclick={() => (leaveAdminTeamName = managedTeams.selectedTeam?.name ?? null)}
				>
					<LogOutIcon class="size-4" /> Verwaltung abgeben
				</Button>
			{/if}
			{#if managedTeams.selectedTeam && managedTeams.isOwner}
				<Button
					variant="ghost"
					size="icon-sm"
					class="ml-auto"
					title="Team endgültig löschen"
					aria-label="Team endgültig löschen"
					onclick={() => (deleteTarget = managedTeams.selectedTeam)}
				>
					<Trash2Icon class="text-destructive size-4" />
				</Button>
			{/if}
		</div>

		<div class="space-y-1.5">
			<Label>Beitritts-Link</Label>
			<InviteLinkField
				url={managedTeams.inviteUrl}
				loading={managedTeams.inviteLoading}
				rotating={managedTeams.rotating}
				emptyText="Noch keinen Link erzeugt."
				oncopy={() => managedTeams.copyInviteUrl()}
				onrotate={rotateInvite}
			/>
			{#if !managedTeams.inviteLoading && managedTeams.inviteUrl}
				<p class="text-muted-foreground text-xs">
					Ein neuer Link macht den bisherigen ungültig - schon beigetretene Mitglieder bleiben davon
					unberührt.
				</p>
			{/if}
		</div>

		{#if addingTeam}
			<div class="flex gap-2 rounded-lg border border-dashed p-3.5">
				<Input
					bind:value={newTeamName}
					placeholder="Name des weiteren Teams"
					aria-label="Name des weiteren Teams"
					onkeydown={(e) => e.key === "Enter" && createTeam()}
				/>
				<Button variant="outline" disabled={!newTeamName.trim() || managedTeams.creating} onclick={createTeam}>
					<PlusIcon class="size-4" /> Anlegen
				</Button>
				<Button
					variant="ghost"
					size="icon"
					title="Abbrechen"
					aria-label="Abbrechen"
					onclick={() => {
						addingTeam = false;
						newTeamName = "";
					}}
				>
					<XIcon class="size-4" />
				</Button>
			</div>
		{:else}
			<Button variant="link" class="h-auto p-0" onclick={() => (addingTeam = true)}>
				<PlusIcon class="size-4" /> Weiteres Team anlegen
			</Button>
		{/if}
	</SettingsCard>

	{#if managedTeams.selectedTeam}
		<SettingsCard title="Verwalter" description="Ein weiteres Konto mit denselben Rechten wie der oder die Vorgesetzte – außer Team löschen, Verwalter einladen oder entfernen und die Leitung übergeben." divided={false}>
			{#if managedTeams.adminsLoading}
				<p class="text-muted-foreground text-sm">Wird geladen…</p>
			{:else if managedTeams.admins.length === 0}
				<div class="flex items-center gap-2.5 rounded-lg border border-dashed p-3.5">
					<div class="bg-muted flex size-7 shrink-0 items-center justify-center rounded-md">
						<ShieldIcon class="text-muted-foreground size-3.5" />
					</div>
					<p class="text-muted-foreground text-xs">Noch kein Verwalter - lade jemanden per Link ein.</p>
				</div>
			{:else}
				<div class="grid gap-2">
					{#each managedTeams.admins as a (a.userId)}
						<div class="flex items-center justify-between gap-3 rounded-lg border bg-card/60 p-2.5 transition-colors hover:bg-card">
							<div class="flex min-w-0 items-center gap-2.5">
								<div class="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold uppercase">
									{a.displayName.slice(0, 1)}
								</div>
								<div class="min-w-0">
									<div class="truncate text-sm font-medium">{a.displayName}</div>
									<div class="text-muted-foreground text-xs">
										Verwalter seit {fmtDateHuman(a.createdAt)}
									</div>
								</div>
							</div>
							{#if managedTeams.isOwner}
								<Button
									variant="ghost"
									size="icon-sm"
									class="text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
									title="Nicht mehr Verwalter"
									aria-label={`${a.displayName} als Verwalter entfernen`}
									onclick={() => removeAdmin(a.userId, a.displayName)}
								>
									<Trash2Icon class="size-3.5" />
								</Button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			{#if managedTeams.isOwner}
				<div class="space-y-1.5">
					<Label>Verwalter einladen</Label>
					<InviteLinkField
						url={managedTeams.adminInviteUrl}
						loading={managedTeams.adminInviteLoading}
						rotating={managedTeams.rotatingAdminInvite}
						emptyText="Kein gültiger Link."
						oncopy={() => managedTeams.copyAdminInviteUrl()}
						onrotate={rotateAdminInvite}
					/>
					{#if !managedTeams.adminInviteLoading}
						<p class="text-muted-foreground text-xs">
							Wer den Link annimmt, sieht alle Berichte des Teams und braucht dafür ein eigenes Konto.
							{#if managedTeams.adminInvite?.expiresAt}
								Der Link gilt bis {fmtDateHuman(managedTeams.adminInvite.expiresAt)}.
							{:else}
								Ein neuer Link gilt 30 Tage.
							{/if}
						</p>
					{/if}
				</div>
			{/if}
		</SettingsCard>
	{/if}

	{#if managedTeams.selectedTeam && managedTeams.isOwner && managedTeams.admins.length > 0}
		<SettingsCard title="Leitung übergeben" description="Ein Verwalter übernimmt die Leitung, du selbst wirst Verwalter – dein Zugang bleibt erhalten." divided={false}>
			<div class="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5">
				<div class="flex size-9 shrink-0 items-center justify-center rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400">
					<ArrowLeftRightIcon class="size-4" />
				</div>
				<div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
					<Select.Root type="single" bind:value={transferPickId}>
						<Select.Trigger class="bg-background w-56">
							{transferTarget?.displayName ?? "Verwalter wählen"}
						</Select.Trigger>
						<Select.Content>
							{#each managedTeams.admins as a (a.userId)}
								<Select.Item value={a.userId} label={a.displayName}>{a.displayName}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
					<Button variant="outline" class="bg-background" disabled={!transferTarget} onclick={startTransfer}>
						<ArrowLeftRightIcon class="size-4" /> Übergeben
					</Button>
				</div>
			</div>
		</SettingsCard>
	{/if}

	<ConfirmDialog
		open={confirmingTransfer}
		class="sm:max-w-md"
		title={`Leitung an „${transferTargetName}“ übergeben?`}
		description={`„${transferTargetName}“ kann das Team danach löschen, Verwalter einladen oder entfernen und erneut übergeben - alles, was bisher nur du konntest. Du selbst bleibst als Verwalter mit dabei.`}
		confirmLabel="Übergeben"
		busyLabel="Wird übergeben…"
		onConfirm={confirmTransfer}
		onClose={() => (confirmingTransfer = false)}
	/>

	<ConfirmDialog
		open={!!leaveAdminTeamName}
		class="sm:max-w-md"
		title={`Verwaltung von „${leaveAdminTeamName}“ abgeben?`}
		description="Du siehst danach weder Mitglieder noch Berichte dieses Teams. Um wieder Verwalter zu werden, brauchst du einen neuen Einladungs-Link von der oder dem Vorgesetzten."
		confirmLabel="Verwaltung abgeben"
		busyLabel="Wird abgegeben…"
		onConfirm={confirmLeaveAdmin}
		onClose={() => (leaveAdminTeamName = null)}
	/>

	<ConfirmDialog
		open={!!deleteTarget}
		class="sm:max-w-md"
		title={`„${deleteTarget?.name}“ endgültig löschen?`}
		description="Mitglieder, gemeinsame Aktivitäten und alle gesendeten Berichte dieses Teams gehen damit unwiderruflich verloren. Der Beitritts-Link wird ungültig. Zeiten, die Mitglieder bereits erfasst hatten, bleiben auf deren eigenen Geräten erhalten."
		confirmLabel="Endgültig löschen"
		busyLabel="Wird gelöscht…"
		onConfirm={confirmDeleteTeam}
		onClose={() => (deleteTarget = null)}
	/>
{/if}
