<script lang="ts">
	import * as Card from "$lib/components/ui/card";
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { toast } from "svelte-sonner";
	import { account } from "$lib/sync/account.svelte";
	import { BACKUPS_KEY, INVITES_KEY, invalidate, warm } from "$lib/prefetch";
	import type { BackupInfo, Invite } from "$lib/sync/api";
	import { fmtDateHuman } from "$lib/time";
	import { inviteLink } from "$lib/invite";
	import LinkIcon from "@lucide/svelte/icons/link";
	import CopyIcon from "@lucide/svelte/icons/copy";
	import CheckIcon from "@lucide/svelte/icons/check";
	import ShieldAlertIcon from "@lucide/svelte/icons/shield-alert";
	import ShieldCheckIcon from "@lucide/svelte/icons/shield-check";
	import UserPlusIcon from "@lucide/svelte/icons/user-plus";
	import BanIcon from "@lucide/svelte/icons/ban";
	import GlobeIcon from "@lucide/svelte/icons/globe";
	import LockIcon from "@lucide/svelte/icons/lock";
	import DatabaseIcon from "@lucide/svelte/icons/database";
	import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
	import RotateCcwIcon from "@lucide/svelte/icons/rotate-ccw";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";
	import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
	import EyeIcon from "@lucide/svelte/icons/eye";
	import EyeOffIcon from "@lucide/svelte/icons/eye-off";
	import { Skeleton } from "$lib/components/ui/skeleton";

	// ---------- State ----------
	let isLoaded = $state(false);
	let isRefreshing = $state(false);

	// Invites & Registration
	let invites = $state<Invite[]>([]);
	let isCreatingInvite = $state(false);
	let isEnvConfigured = $state(false);
	let isEnvActive = $state(true);
	let isEnvUpdating = $state(false);
	let isRegistrationOpen = $state(false);
	let isRegistrationUpdating = $state(false);
	let inviteNote = $state("");
	let inviteDays = $state("");
	let latestInviteCode = $state("");
	let isLinkCopied = $state(false);
	let isCodeCopied = $state(false);

	// Backups
	let backups = $state<BackupInfo[]>([]);
	let isCreatingBackup = $state(false);
	let backupToRestore = $state<BackupInfo | null>(null);
	let isRestoring = $state(false);
	let isDeletingBackup = $state<string | null>(null);

	// ---------- Helpers ----------
	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	}

	async function copyToClipboard(text: string, notify: (active: boolean) => void) {
		try {
			await navigator.clipboard.writeText(text);
			notify(true);
			setTimeout(() => notify(false), 2000);
		} catch {
			toast.error("Kopieren nicht möglich – bitte von Hand markieren.");
		}
	}

	const baseUrl = $derived(
		account.serverUrl || (typeof location !== "undefined" ? location.origin : "")
	);

	const copyInviteLink = (code: string) =>
		copyToClipboard(inviteLink(baseUrl, code), (active) => (isLinkCopied = active));
	const copyInviteCode = (code: string) =>
		copyToClipboard(code, (active) => (isCodeCopied = active));

	// ---------- API Calls ----------
	/** `fresh` umgeht den Puffer - nach einer Aenderung soll wirklich gefragt werden. */
	async function loadData(fresh = false) {
		try {
			if (fresh) {
				invalidate(INVITES_KEY);
				invalidate(BACKUPS_KEY);
			}
			const [invitesRes, backupsRes] = await Promise.all([
				warm(INVITES_KEY, () => account.invites()),
				warm(BACKUPS_KEY, () => account.backups()).catch(() => [])
			]);
			invites = invitesRes.invites;
			isEnvConfigured = invitesRes.envInvitesConfigured;
			isEnvActive = invitesRes.envInvitesActive;
			isRegistrationOpen = invitesRes.openRegistration;
			backups = backupsRes;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Verwaltungsdaten nicht abrufbar");
		} finally {
			isLoaded = true;
			isRefreshing = false;
		}
	}

	$effect(() => {
		if (account.isAdmin && !isLoaded) void loadData();
	});

	async function refreshAll() {
		isRefreshing = true;
		await loadData(true);
	}

	async function handleToggleRegistration() {
		isRegistrationUpdating = true;
		const target = !isRegistrationOpen;
		try {
			isRegistrationOpen = await account.setOpenRegistration(target);
			if (isRegistrationOpen) {
				toast.success("Offene Registrierung aktiviert. Jeder kann sich jetzt ohne Einladungscode registrieren.");
			} else {
				toast.success("Offene Registrierung deaktiviert. Neue Konten brauchen wieder einen Einladungscode.");
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Änderung fehlgeschlagen");
		} finally {
			isRegistrationUpdating = false;
		}
	}

	async function handleToggleEnvInvites() {
		isEnvUpdating = true;
		const target = !isEnvActive;
		try {
			isEnvActive = await account.setEnvInvites(target);
			if (!isEnvActive) {
				toast.success("Statische Einladungscodes (.env) wurden deaktiviert.");
			} else {
				toast.success("Statische Einladungscodes (.env) wurden wieder aktiviert.");
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Änderung fehlgeschlagen");
		} finally {
			isEnvUpdating = false;
		}
	}

	async function handleCreateInvite() {
		isCreatingInvite = true;
		try {
			const created = await account.createInvite({
				note: inviteNote.trim() || undefined,
				validDays: inviteDays ? Number(inviteDays) : undefined
			});
			latestInviteCode = created.code;
			inviteNote = "";
			inviteDays = "";
			await loadData(true);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Ausstellen fehlgeschlagen");
		} finally {
			isCreatingInvite = false;
		}
	}

	async function handleRevokeInvite(code: string) {
		try {
			await account.revokeInvite(code);
			if (latestInviteCode === code) latestInviteCode = "";
			await loadData(true);
			toast.success("Einladung zurückgezogen.");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Zurückziehen fehlgeschlagen");
		}
	}

	async function handleCreateBackup() {
		isCreatingBackup = true;
		try {
			const backup = await account.createBackup();
			toast.success(`Sicherung erfolgreich erstellt: ${backup.name}`);
			await loadData(true);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Sicherung fehlgeschlagen");
		} finally {
			isCreatingBackup = false;
		}
	}

	async function handleConfirmRestore() {
		if (!backupToRestore) return;
		isRestoring = true;
		const targetName = backupToRestore.name;
		try {
			const res = await account.restoreBackup(targetName);
			toast.success(`Sicherung ${res.restored} erfolgreich wiederhergestellt.`);
			backupToRestore = null;
			await loadData(true);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Wiederherstellung fehlgeschlagen");
		} finally {
			isRestoring = false;
		}
	}

	async function handleDeleteBackup(name: string) {
		isDeletingBackup = name;
		try {
			await account.deleteBackup(name);
			toast.success(`Sicherungsdatei gelöscht.`);
			await loadData(true);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Löschen fehlgeschlagen");
		} finally {
			isDeletingBackup = null;
		}
	}

	function getInviteStatus(invite: Invite): { text: string; isOpen: boolean; badgeClass: string } {
		if (invite.usedAt) {
			return {
				text: `Genutzt ${fmtDateHuman(invite.usedAt)}`,
				isOpen: false,
				badgeClass: "bg-muted text-muted-foreground"
			};
		}
		if (invite.revokedAt) {
			return {
				text: "Zurückgezogen",
				isOpen: false,
				badgeClass: "border-destructive/30 bg-destructive/10 text-destructive"
			};
		}
		if (invite.expiresAt && invite.expiresAt < Date.now()) {
			return {
				text: "Abgelaufen",
				isOpen: false,
				badgeClass: "border-muted-foreground/30 bg-muted text-muted-foreground"
			};
		}
		if (invite.expiresAt) {
			return {
				text: `Gültig bis ${fmtDateHuman(invite.expiresAt)}`,
				isOpen: true,
				badgeClass: "border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
			};
		}
		return {
			text: "Offen",
			isOpen: true,
			badgeClass: "border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
		};
	}

	// Benutzte/inaktive Einladungen standardmäßig ausblenden (kann umgeschaltet werden)
	let showUsedInvites = $state(false);

	function isInviteOpen(i: Invite): boolean {
		return !i.usedAt && !i.revokedAt && (!i.expiresAt || i.expiresAt > Date.now());
	}

	const openInvites = $derived(invites.filter(isInviteOpen));
	const usedInvites = $derived(invites.filter((i) => !isInviteOpen(i)));

	const sortedAndFilteredInvites = $derived.by(() => {
		// 1. Offene Einladungen (neueste zuerst nach Erstellung)
		const openSorted = [...openInvites].sort((a, b) => b.createdAt - a.createdAt);

		// Wenn benutzte ausgeblendet sind: nur die offenen anzeigen
		if (!showUsedInvites) {
			return openSorted;
		}

		// 2. Benutzte / inaktive Einladungen (nach Verwendungs-/Widerrufszeit bzw. Erstellung absteigend)
		const usedSorted = [...usedInvites].sort((a, b) => {
			const timeA = a.usedAt ?? a.revokedAt ?? a.expiresAt ?? a.createdAt;
			const timeB = b.usedAt ?? b.revokedAt ?? b.expiresAt ?? b.createdAt;
			return timeB - timeA;
		});

		return [...openSorted, ...usedSorted];
	});
</script>

{#if account.isAdmin}
	<div class="space-y-6">
		<!-- 1. Kachel: Server-Datensicherungen -->
		<Card.Root>
			<Card.Header>
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-2">
						<DatabaseIcon class="size-5 text-primary shrink-0" />
						<Card.Title>Server-Datensicherungen</Card.Title>
					</div>
					<Button
						variant="outline"
						size="sm"
						class="gap-1.5"
						onclick={handleCreateBackup}
						disabled={isCreatingBackup}
					>
						<RefreshCwIcon class="size-3.5 {isCreatingBackup ? 'animate-spin' : ''}" />
						{isCreatingBackup ? "Sichert…" : "Jetzt sichern"}
					</Button>
				</div>
				<Card.Description>
					Automatische und manuelle SQLite-Sicherungen verwalten und bei Bedarf in den Live-Server einspielen.
				</Card.Description>
			</Card.Header>

			<Card.Content class="space-y-4">
				<div class="space-y-2">
					<div class="flex items-center justify-between">
						<Label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
							Vorhandene Sicherungen ({backups.length})
						</Label>
					</div>

					{#if !isLoaded}
						<div class="divide-y rounded-lg border bg-card">
							{#each Array(3) as _}
								<div class="flex items-center justify-between p-3">
									<div class="space-y-1.5 min-w-0 flex-1">
										<Skeleton class="h-4 w-52" />
										<Skeleton class="h-3 w-32" />
									</div>
									<div class="flex items-center gap-2">
										<Skeleton class="h-8 w-24" />
										<Skeleton class="h-8 w-8 rounded-md" />
									</div>
								</div>
							{/each}
						</div>
					{:else if backups.length === 0}
						<div class="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
							Noch keine Datensicherungen auf dem Server vorhanden.
						</div>
					{:else}
						<div class="divide-y rounded-lg border bg-card">
							{#each backups as b (b.name)}
								<div class="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
									<div class="min-w-0">
										<div class="flex items-center gap-2">
											<span class="font-mono text-xs font-medium text-foreground">{b.name}</span>
											<Badge
												variant="outline"
												class="text-[10px] px-1.5 py-0.5 font-normal {b.verified
													? 'border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
													: 'border-destructive/40 bg-destructive/10 text-destructive'}"
											>
												{b.verified ? "Integrität OK" : "Prüfung fehlgeschlagen"}
											</Badge>
										</div>
										<p class="text-muted-foreground text-xs mt-0.5">
											{fmtDateHuman(b.mtime)} · {formatBytes(b.size)}
										</p>
									</div>

									<div class="flex shrink-0 items-center gap-2">
										<Button
											variant="outline"
											size="sm"
											class="h-8 gap-1.5 text-xs"
											onclick={() => (backupToRestore = b)}
											disabled={!b.verified}
										>
											<RotateCcwIcon class="size-3.5 text-primary" />
											Wiederherstellen
										</Button>
										<Button
											variant="ghost"
											size="icon-sm"
											class="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
											title="Sicherung löschen"
											onclick={() => handleDeleteBackup(b.name)}
											disabled={isDeletingBackup === b.name}
										>
											<Trash2Icon class="size-3.5" />
										</Button>
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>

		<!-- 2. Kachel: Registrierung & Einladungen -->
		<Card.Root>
			<Card.Header>
				<div class="flex items-center gap-2">
					<ShieldCheckIcon class="size-5 text-primary shrink-0" />
					<Card.Title>Registrierung & Einladungen</Card.Title>
				</div>
				<Card.Description>
					Registrierungsrichtlinien steuern und Einladungscodes für neue Team-Mitglieder vergeben.
				</Card.Description>
			</Card.Header>

			<Card.Content class="space-y-4">
				<!-- Haupt-Richtlinie: Offene Registrierung vs. Nur mit Einladung -->
				{#if isRegistrationOpen}
					<div class="border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200 flex flex-col gap-3 rounded-lg border p-3.5 text-sm sm:flex-row sm:items-center sm:justify-between">
						<div class="flex items-start gap-2.5">
							<GlobeIcon class="text-amber-600 dark:text-amber-400 mt-0.5 size-5 shrink-0" />
							<div>
								<p class="font-medium">Öffentliche Registrierung ist aktiv</p>
								<p class="text-xs opacity-90 leading-relaxed">
									Jede Person, die die Serveradresse kennt, kann sich direkt ohne Einladungscode registrieren.
								</p>
							</div>
						</div>
						<Button
							variant="outline"
							size="sm"
							class="shrink-0 self-start sm:self-center"
							onclick={handleToggleRegistration}
							disabled={isRegistrationUpdating}
						>
							{isRegistrationUpdating ? "Wird umgestellt…" : "Einladungscode erzwingen"}
						</Button>
					</div>
				{:else}
					<div class="border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200 flex flex-col gap-3 rounded-lg border p-3.5 text-sm sm:flex-row sm:items-center sm:justify-between">
						<div class="flex items-start gap-2.5">
							<LockIcon class="text-emerald-600 dark:text-emerald-400 mt-0.5 size-5 shrink-0" />
							<div>
								<p class="font-medium">Registrierung nur mit Einladungscode</p>
								<p class="text-xs opacity-90 leading-relaxed">
									Geschlossener Server: Neue Konten können sich nur über gültige Einladungscodes registrieren.
								</p>
							</div>
						</div>
						<Button
							variant="outline"
							size="sm"
							class="shrink-0 self-start sm:self-center"
							onclick={handleToggleRegistration}
							disabled={isRegistrationUpdating}
						>
							{isRegistrationUpdating ? "Wird umgestellt…" : "Offene Registrierung erlauben"}
						</Button>
					</div>
				{/if}

				{#if !isRegistrationOpen && isEnvConfigured}
					{#if isEnvActive}
						<div class="border-amber-500/30 bg-amber-500/5 text-amber-900 dark:text-amber-200 flex flex-col gap-2 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
							<div class="flex items-start gap-2.5">
								<ShieldAlertIcon class="text-amber-600 dark:text-amber-400 mt-0.5 size-4 shrink-0" />
								<div>
									<p class="font-medium text-xs">Statische .env-Codes sind aktiv</p>
									<p class="text-[11px] opacity-90 leading-relaxed">
										Der Server akzeptiert noch statische Codes aus der Konfiguration.
									</p>
								</div>
							</div>
							<Button
								variant="destructive"
								size="sm"
								class="h-7 text-xs shrink-0 self-start sm:self-center"
								onclick={handleToggleEnvInvites}
								disabled={isEnvUpdating}
							>
								{isEnvUpdating ? "Wird deaktiviert…" : "Codes deaktivieren"}
							</Button>
						</div>
					{:else}
						<div class="border-border/60 bg-muted/40 text-muted-foreground flex flex-col gap-2 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
							<div class="flex items-start gap-2.5">
								<ShieldCheckIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
								<div>
									<p class="text-foreground font-medium text-xs">Statische .env-Codes sind deaktiviert</p>
									<p class="text-[11px] opacity-90 leading-relaxed">
										Nur noch individuell ausgestellte Einladungscodes werden akzeptiert.
									</p>
								</div>
							</div>
							<Button
								variant="outline"
								size="sm"
								class="h-7 text-xs shrink-0 self-start sm:self-center"
								onclick={handleToggleEnvInvites}
								disabled={isEnvUpdating}
							>
								{isEnvUpdating ? "Wird aktiviert…" : "Wieder aktivieren"}
							</Button>
						</div>
					{/if}
				{/if}

				{#if latestInviteCode}
					<div class="border-primary/40 bg-primary/5 space-y-3 rounded-lg border p-4">
						<div>
							<p class="font-medium text-sm text-foreground">Neue Einladung erstellt – gilt genau einmal:</p>
							<p class="font-mono text-2xl tracking-wider select-all text-primary font-semibold mt-1">{latestInviteCode}</p>
						</div>

						<div class="flex flex-wrap items-center gap-2 pt-1">
							<Button variant="outline" size="sm" class="gap-1.5" onclick={() => copyInviteLink(latestInviteCode)}>
								{#if isLinkCopied}
									<CheckIcon class="size-4 text-emerald-500" /> Link kopiert
								{:else}
									<LinkIcon class="size-4" /> Einladungslink kopieren
								{/if}
							</Button>
							<Button variant="ghost" size="sm" class="gap-1.5" onclick={() => copyInviteCode(latestInviteCode)}>
								{#if isCodeCopied}
									<CheckIcon class="size-4 text-emerald-500" /> Code kopiert
								{:else}
									<CopyIcon class="size-4" /> Nur den Code
								{/if}
							</Button>
						</div>

						<p class="text-muted-foreground text-xs">
							Code oder Link an das Team-Mitglied weitergeben. Er erscheint auch unten in der Einladungsliste.
						</p>
					</div>
				{/if}

				<!-- Neue Einladung ausstellen -->
				<div class="space-y-3 rounded-lg border bg-muted/20 p-3.5">
					<div>
						<p class="font-medium text-sm text-foreground">Neue Einladung ausstellen</p>
						<p class="text-muted-foreground text-xs">
							Erzeugt einen einmalig gültigen Code zur Kontoerstellung.
						</p>
					</div>
					<div class="grid gap-2.5 sm:grid-cols-[1fr_auto]">
						<div class="space-y-1">
							<Label for="inote" class="text-xs">Notiz / Empfänger (optional)</Label>
							<Input
								id="inote"
								bind:value={inviteNote}
								placeholder="z. B. Kollegin Maxima"
								class="text-sm"
								onkeydown={(e) => e.key === "Enter" && !isCreatingInvite && handleCreateInvite()}
							/>
						</div>
						<div class="space-y-1">
							<Label for="itage" class="text-xs">Gültig (Tage)</Label>
							<Input
								id="itage"
								bind:value={inviteDays}
								type="number"
								min="1"
								placeholder="∞"
								class="w-28 text-sm"
								onkeydown={(e) => e.key === "Enter" && !isCreatingInvite && handleCreateInvite()}
							/>
						</div>
					</div>
					<Button onclick={handleCreateInvite} disabled={isCreatingInvite} class="gap-1.5">
						<UserPlusIcon class="size-4" />
						{isCreatingInvite ? "Stellt aus…" : "Einladung ausstellen"}
					</Button>
				</div>

				<!-- Liste der Einladungen -->
				<div class="space-y-2 pt-1">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<Label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
							Ausgestellte Einladungen ({invites.length})
							{#if openInvites.length > 0}
								<span class="text-emerald-600 dark:text-emerald-400 font-normal"> · {openInvites.length} offen</span>
							{/if}
						</Label>

						{#if usedInvites.length > 0}
							<Button
								variant="ghost"
								size="sm"
								class="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
								onclick={() => (showUsedInvites = !showUsedInvites)}
							>
								{#if showUsedInvites}
									<EyeOffIcon class="size-3.5" />
									Benutzte ausblenden ({usedInvites.length})
								{:else}
									<EyeIcon class="size-3.5" />
									Benutzte anzeigen ({usedInvites.length})
								{/if}
							</Button>
						{/if}
					</div>

					{#if !isLoaded}
						<div class="divide-y rounded-lg border bg-card">
							{#each Array(3) as _}
								<div class="flex items-center justify-between p-3">
									<div class="space-y-1.5 min-w-0 flex-1">
										<Skeleton class="h-4 w-44 font-mono" />
										<Skeleton class="h-3 w-28" />
									</div>
									<div class="flex items-center gap-2">
										<Skeleton class="h-6 w-16 rounded-full" />
										<Skeleton class="h-8 w-8 rounded-md" />
									</div>
								</div>
							{/each}
						</div>
					{:else if invites.length === 0}
						<div class="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
							Noch keine Einladungen ausgestellt.
						</div>
					{:else if sortedAndFilteredInvites.length === 0}
						<div class="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground space-y-2">
							<p>Keine offenen Einladungen vorhanden.</p>
							<p class="text-xs opacity-80">{usedInvites.length} genutzte oder abgelaufene Einladungen sind ausgeblendet.</p>
							<Button
								variant="outline"
								size="sm"
								class="gap-1.5 text-xs mt-1"
								onclick={() => (showUsedInvites = true)}
							>
								<EyeIcon class="size-3.5" />
								Benutzte Einladungen einblenden
							</Button>
						</div>
					{:else}
						<div class="divide-y rounded-lg border bg-card">
							{#each sortedAndFilteredInvites as i (i.code)}
								{@const status = getInviteStatus(i)}
								<div class="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
									<div class="min-w-0">
										<div class="flex items-center gap-2">
											<span class="font-mono font-medium tracking-wide text-foreground">{i.code}</span>
											{#if i.note}
												<span class="text-muted-foreground truncate text-xs">· {i.note}</span>
											{/if}
										</div>
									</div>
									<div class="flex shrink-0 items-center gap-2">
										<Badge variant="outline" class="text-[10px] px-2 py-0.5 font-normal {status.badgeClass}">
											{status.text}
										</Badge>
										{#if !i.usedAt && !i.revokedAt}
											<Button
												variant="ghost"
												size="icon-sm"
												class="text-muted-foreground hover:text-foreground"
												title="Einladungslink kopieren"
												onclick={() => copyInviteLink(i.code)}
											>
												<LinkIcon class="size-3.5" />
											</Button>
											<Button
												variant="ghost"
												size="sm"
												class="text-muted-foreground hover:text-destructive hover:bg-destructive/10 text-xs gap-1"
												onclick={() => handleRevokeInvite(i.code)}
											>
												<BanIcon class="size-3.5" />
												Zurückziehen
											</Button>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>
	</div>
{/if}

<!-- Bestätigungsdialog zur Wiederherstellung eines Backups -->
<Dialog.Root
	open={backupToRestore !== null}
	onOpenChange={(open) => {
		if (!open && !isRestoring) backupToRestore = null;
	}}
>
	<Dialog.Content
		interactOutsideBehavior={isRestoring ? "ignore" : "close"}
		escapeKeydownBehavior={isRestoring ? "ignore" : "close"}
		showCloseButton={!isRestoring}
	>
		<Dialog.Header>
			<div class="flex items-center gap-2">
				<TriangleAlertIcon class="size-5 text-amber-600 dark:text-amber-400 shrink-0" />
				<Dialog.Title>Server-Sicherung wiederherstellen?</Dialog.Title>
			</div>
			<Dialog.Description class="space-y-2 pt-1 text-sm">
				<p>
					Möchtest du den Server auf den Stand der Sicherung <strong class="font-mono text-foreground">{backupToRestore?.name}</strong> zurücksetzen?
				</p>
				<div class="border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200 rounded-lg border p-3 text-xs leading-relaxed">
					<p class="font-medium mb-1">Automatische Sicherheit:</p>
					Vor dem Einspielen wird automatisch ein Sicherungs-Snapshot des aktuellen Live-Zustands erstellt.
				</div>
			</Dialog.Description>
		</Dialog.Header>

		<Dialog.Footer class="gap-3">
			<Button
				variant="outline"
				onclick={() => (backupToRestore = null)}
				disabled={isRestoring}
			>
				Abbrechen
			</Button>
			<Button
				variant="default"
				onclick={handleConfirmRestore}
				disabled={isRestoring}
				class="gap-1.5"
			>
				<RotateCcwIcon class="size-4 {isRestoring ? 'animate-spin' : ''}" />
				{isRestoring ? "Spielt ein…" : "Sicherung jetzt einspielen"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

