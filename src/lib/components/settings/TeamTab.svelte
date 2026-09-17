<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { account } from "$lib/sync/account.svelte";
	import { chefTeams } from "$lib/team/chef.svelte";
	import type { TeamInfo } from "$lib/sync/api";
	import { fmtDateHuman } from "$lib/time/time";
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
	import ArrowLeftRightIcon from "@lucide/svelte/icons/arrow-left-right";
	import CloudIcon from "@lucide/svelte/icons/cloud";
	import Link2Icon from "@lucide/svelte/icons/link-2";
	import ShieldIcon from "@lucide/svelte/icons/shield";
	import XIcon from "@lucide/svelte/icons/x";

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
		const teamId = chefTeams.selectedTeamId;
		if (!form.bossMode || !teamId) return;
		// Fehlt der Link noch (frisch angelegtes Team), gleich erzeugen statt den
		// Chef erst auf "Link erzeugen" klicken zu lassen.
		void chefTeams.loadInvite(teamId).then((ok) => {
			if (ok && teamId === chefTeams.selectedTeamId && !chefTeams.invite && chefTeams.isOwner) {
				void rotateInvite();
			}
		});
		void chefTeams.loadAdmins(teamId);
		if (chefTeams.isOwner) void chefTeams.loadAdminInvite(teamId);
	});

	let newTeamName = $state("");
	// Nur beim ersten Team immer sichtbar - sobald eines existiert, verschwindet
	// das Formular hinter "Weiteres Team anlegen", damit die Karte nicht
	// dauerhaft ein Eingabefeld zeigt, das die meisten nie ein zweites Mal brauchen.
	let addingTeam = $state(false);

	async function createTeam() {
		const name = newTeamName.trim();
		if (!name || chefTeams.creating) return;
		try {
			await chefTeams.createTeam(name);
			newTeamName = "";
			addingTeam = false;
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

	// ---------- Verwalter ----------

	async function rotateAdminInvite() {
		try {
			await chefTeams.rotateAdminInvite();
		} catch (e) {
			toast.error(`Verwalter-Link konnte nicht erzeugt werden: ${errorText(e)}`);
		}
	}

	async function removeAdmin(userId: string, name: string) {
		try {
			await chefTeams.removeAdmin(userId);
			toast.success(`„${name}" ist nicht mehr Verwalter.`);
		} catch (e) {
			toast.error(`Entfernen fehlgeschlagen: ${errorText(e)}`);
		}
	}

	// Auswahl per Dropdown, Bestaetigung per Dialog: uebergibt der Chef
	// versehentlich an die falsche Person, ist das nur durch die neue Chefin
	// rueckgaengig zu machen, nicht mehr von hier aus.
	let transferPickId = $state<string | undefined>(undefined);
	const transferTarget = $derived(
		chefTeams.admins.find((a) => a.userId === transferPickId) ?? null
	);
	let confirmingTransfer = $state(false);
	let transferring = $state(false);
	// Eigener Stand statt live aus chefTeams.admins gelesen: transferOwnership()
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
		transferring = true;
		try {
			const userId = transferTarget.userId;
			await chefTeams.transferOwnership(userId);
			toast.success(`„${transferTargetName}" ist jetzt Chef/in dieses Teams.`);
			confirmingTransfer = false;
			transferPickId = undefined;
		} catch (e) {
			toast.error(`Übergabe fehlgeschlagen: ${errorText(e)}`);
		} finally {
			transferring = false;
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
	description="Team anlegen, Mitglieder per Link einladen, Bericht-Status sehen."
	savedAt={savedBossAt}
>
	<SettingToggle
		id="bossmode"
		title="Team-Tab anzeigen"
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
	<SettingsCard title="Team anlegen" divided={false}>
		<div class="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/20 p-3.5">
			<div class="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-md">
				<CloudIcon class="size-4" />
			</div>
			<p class="text-muted-foreground min-w-0 flex-1 text-xs">
				Braucht ein Konto - Team und Beitritts-Link liegen dort, nicht nur auf diesem Gerät.
			</p>
			<Button size="sm" class="shrink-0" onclick={() => tabFocus.requestSettings("konto")}>
				Zu den Konto-Einstellungen
			</Button>
		</div>
	</SettingsCard>
{:else if form.bossMode && chefTeams.teamsLoading && chefTeams.teams.length === 0}
	<SettingsCard title="Team anlegen" divided={false}>
		<p class="text-muted-foreground text-sm">Wird geladen…</p>
	</SettingsCard>
{:else if form.bossMode && chefTeams.teams.length === 0}
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
				<Button variant="outline" disabled={!newTeamName.trim() || chefTeams.creating} onclick={createTeam}>
					<PlusIcon class="size-4" /> Anlegen
				</Button>
			</div>
		</div>
	</SettingsCard>
{:else if form.bossMode}
	<SettingsCard title="Team" description="Beitritts-Link zum Einladen von Mitgliedern." divided={false}>
		<div class="flex items-center gap-2">
			{#if chefTeams.teams.length > 1}
				<Select.Root type="single" bind:value={chefTeams.selectedTeamId}>
					<Select.Trigger aria-label="Team wählen" class="w-56">
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
			{#if chefTeams.selectedTeam && !chefTeams.isOwner}
				<span class="text-muted-foreground text-xs">(du bist Verwalter/in, nicht Chef/in)</span>
			{/if}
			{#if chefTeams.selectedTeam && chefTeams.isOwner}
				<Button
					variant="ghost"
					size="icon-sm"
					class="ml-auto"
					title="Team endgültig löschen"
					onclick={() => (deleteTarget = chefTeams.selectedTeam)}
				>
					<Trash2Icon class="text-destructive size-4" />
				</Button>
			{/if}
		</div>

		<div class="space-y-1.5">
			<Label>Beitritts-Link</Label>
			{#if chefTeams.inviteLoading}
				<p class="text-muted-foreground text-sm">Wird geladen…</p>
			{:else if chefTeams.inviteUrl}
				<div class="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-2.5">
					<div class="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-md">
						<Link2Icon class="size-3.5" />
					</div>
					<code class="min-w-0 flex-1 truncate text-xs">{chefTeams.inviteUrl}</code>
					<Button variant="ghost" size="icon-sm" title="Link kopieren" onclick={() => chefTeams.copyInviteUrl()}>
						<CopyIcon class="size-4" />
					</Button>
					<Button variant="outline" size="sm" disabled={chefTeams.rotating} onclick={rotateInvite}>
						<RefreshCwIcon class="size-4" /> Neuen Link erzeugen
					</Button>
				</div>
				<p class="text-muted-foreground text-xs">
					Ein neuer Link macht den bisherigen ungültig - schon beigetretene Mitglieder bleiben davon
					unberührt.
				</p>
			{:else}
				<div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-3.5">
					<div class="flex items-center gap-2.5">
						<div class="bg-muted flex size-7 shrink-0 items-center justify-center rounded-md">
							<Link2Icon class="text-muted-foreground size-3.5" />
						</div>
						<p class="text-muted-foreground text-xs">Noch keinen Link erzeugt.</p>
					</div>
					<Button variant="outline" size="sm" disabled={chefTeams.rotating} onclick={rotateInvite}>
						<RefreshCwIcon class="size-4" /> Link erzeugen
					</Button>
				</div>
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
				<Button variant="outline" disabled={!newTeamName.trim() || chefTeams.creating} onclick={createTeam}>
					<PlusIcon class="size-4" /> Anlegen
				</Button>
				<Button
					variant="ghost"
					size="icon"
					title="Abbrechen"
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

	{#if chefTeams.selectedTeam}
		<SettingsCard title="Verwalter" description="Ein zweites Konto mit denselben Rechten wie der Chef - ausser Team löschen, Verwalter ein-/aussetzen oder übergeben." divided={false}>
			{#if chefTeams.adminsLoading}
				<p class="text-muted-foreground text-sm">Wird geladen…</p>
			{:else if chefTeams.admins.length === 0}
				<div class="flex items-center gap-2.5 rounded-lg border border-dashed p-3.5">
					<div class="bg-muted flex size-7 shrink-0 items-center justify-center rounded-md">
						<ShieldIcon class="text-muted-foreground size-3.5" />
					</div>
					<p class="text-muted-foreground text-xs">Noch kein Verwalter - lade jemanden per Link ein.</p>
				</div>
			{:else}
				<div class="grid gap-2">
					{#each chefTeams.admins as a (a.userId)}
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
							{#if chefTeams.isOwner}
								<Button
									variant="ghost"
									size="icon-sm"
									class="text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
									title="Nicht mehr Verwalter"
									onclick={() => removeAdmin(a.userId, a.displayName)}
								>
									<Trash2Icon class="size-3.5" />
								</Button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			{#if chefTeams.isOwner}
				<div class="space-y-1.5">
					<Label>Verwalter einladen</Label>
					{#if chefTeams.adminInviteLoading}
						<p class="text-muted-foreground text-sm">Wird geladen…</p>
					{:else if chefTeams.adminInviteUrl}
						<div class="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-2.5">
							<div class="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-md">
								<Link2Icon class="size-3.5" />
							</div>
							<code class="min-w-0 flex-1 truncate text-xs">{chefTeams.adminInviteUrl}</code>
							<Button
								variant="ghost"
								size="icon-sm"
								title="Link kopieren"
								onclick={() => chefTeams.copyAdminInviteUrl()}
							>
								<CopyIcon class="size-4" />
							</Button>
							<Button variant="outline" size="sm" disabled={chefTeams.rotatingAdminInvite} onclick={rotateAdminInvite}>
								<RefreshCwIcon class="size-4" /> Neuen Link erzeugen
							</Button>
						</div>
					{:else}
						<div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-3.5">
							<div class="flex items-center gap-2.5">
								<div class="bg-muted flex size-7 shrink-0 items-center justify-center rounded-md">
									<Link2Icon class="text-muted-foreground size-3.5" />
								</div>
								<p class="text-muted-foreground text-xs">Noch keinen Link erzeugt.</p>
							</div>
							<Button variant="outline" size="sm" disabled={chefTeams.rotatingAdminInvite} onclick={rotateAdminInvite}>
								<RefreshCwIcon class="size-4" /> Link erzeugen
							</Button>
						</div>
					{/if}
					{#if !chefTeams.adminInviteLoading}
						<p class="text-muted-foreground text-xs">
							Wer den Link öffnet, braucht (anders als beim Beitritts-Link) ein eigenes Konto auf
							diesem Server.
						</p>
					{/if}
				</div>
			{/if}
		</SettingsCard>
	{/if}

	{#if chefTeams.selectedTeam && chefTeams.isOwner && chefTeams.admins.length > 0}
		<SettingsCard title="Eigentum übergeben" description="Ein bestehender Verwalter wird zum Chef, du selbst zum Verwalter - der Zugang bleibt erhalten." divided={false}>
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
							{#each chefTeams.admins as a (a.userId)}
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

	<Dialog.Root
		open={confirmingTransfer}
		onOpenChange={(v) => {
			if (!v && !transferring) confirmingTransfer = false;
		}}
	>
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title>Chef-Rolle an „{transferTargetName}" übergeben?</Dialog.Title>
				<Dialog.Description>
					„{transferTargetName}" kann das Team danach löschen, Verwalter ein-/aussetzen und
					erneut übergeben - alles, was bisher nur du konntest. Du selbst bleibst als Verwalter
					mit dabei.
				</Dialog.Description>
			</Dialog.Header>
			<Dialog.Footer>
				<Button
					type="button"
					variant="outline"
					onclick={() => (confirmingTransfer = false)}
					disabled={transferring}
				>
					Abbrechen
				</Button>
				<Button type="button" variant="destructive" onclick={confirmTransfer} disabled={transferring}>
					<ArrowLeftRightIcon class="size-4" />
					{transferring ? "Wird übergeben…" : "Übergeben"}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>

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
