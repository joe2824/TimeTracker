<script lang="ts">
	import { invoke } from "@tauri-apps/api/core";
	import { save } from "@tauri-apps/plugin-dialog";
	import { account } from "$lib/sync/account.svelte";
	import { chefTeams } from "$lib/team/chef.svelte";
	import { capabilities, isTauri } from "$lib/platform/env";
	import { ApiError, type TeamMemberInfo, type TeamReportStatus } from "$lib/sync/api";
	import { createOutlookDraft, reportOutlookError } from "$lib/report/outlook";
	import { teamReminderHtml, teamReminderSubject, teamReportsToCsv } from "$lib/report/teamReport";
	import { fmtClock, fmtDateHuman, fmtHours, monthLabel, prevMonthKey } from "$lib/time/time";
	import { errorText, logError, logInfo } from "$lib/log";
	import { cleanEmail } from "$shared/email";
	import { tabFocus } from "$lib/ui/tabFocus.svelte";
	import { Button, buttonVariants } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import MonthSelector from "$lib/components/shared/MonthSelector.svelte";
	import StatTile from "$lib/components/shared/StatTile.svelte";
	import * as Card from "$lib/components/ui/card";
	import * as Table from "$lib/components/ui/table";
	import * as Popover from "$lib/components/ui/popover";
	import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
	import * as Dialog from "$lib/components/ui/dialog";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import { cn } from "$lib/utils";
	import { toast } from "svelte-sonner";
	import DownloadIcon from "@lucide/svelte/icons/download";
	import BellIcon from "@lucide/svelte/icons/bell";
	import CheckIcon from "@lucide/svelte/icons/check";
	import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
	import CopyIcon from "@lucide/svelte/icons/copy";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";
	import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
	import XIcon from "@lucide/svelte/icons/x";
	import UserPlusIcon from "@lucide/svelte/icons/user-plus";
	import SettingsIcon from "@lucide/svelte/icons/settings";
	import LayersIcon from "@lucide/svelte/icons/layers";
	import CloudIcon from "@lucide/svelte/icons/cloud";
	import UsersIcon from "@lucide/svelte/icons/users";
	import PlusIcon from "@lucide/svelte/icons/plus";
	import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";

	// ---------- Team verwalten (Roster) ----------
	//
	// Anlegen, Auswahl und Beitritts-Link teilt sich dieser Tab mit den
	// Einstellungen (dort verwaltet, siehe TeamTab) über chefTeams - nur das
	// Kopieren des Links bleibt zusätzlich hier, griffbereit für den Alltag.

	let members = $state<TeamMemberInfo[]>([]);

	// Zählt jeden Abruf durch - läuft eine spätere Auswahl (anderes Team/Monat)
	// einer langsameren früheren Antwort den Rang ab, verwirft deren `then` sich
	// selbst. Ohne das könnte eine veraltete Antwort die gerade angezeigten
	// Daten des inzwischen ausgewählten Teams überschreiben.
	let membersRequest = 0;

	async function loadMembers(teamId: string) {
		const requestId = ++membersRequest;
		try {
			const mem = await account.listTeamMembers(teamId);
			if (requestId !== membersRequest) return;
			members = mem;
		} catch (e) {
			if (requestId !== membersRequest) return;
			toast.error(`Mitglieder konnten nicht geladen werden: ${errorText(e)}`);
		}
	}

	$effect(() => {
		const teamId = chefTeams.selectedTeamId;
		if (teamId) {
			void loadMembers(teamId);
			void chefTeams.loadInvite(teamId);
		} else {
			members = [];
		}
	});

	/** Rückfrage vor Schritten, die sich nicht mit einem Klick zurückholen lassen. */
	let pendingConfirm = $state<{ title: string; text: string; action: string; run: () => Promise<void> } | null>(null);
	let confirmBusy = $state(false);

	async function runConfirmed() {
		if (!pendingConfirm) return;
		confirmBusy = true;
		try {
			await pendingConfirm.run();
		} finally {
			confirmBusy = false;
			pendingConfirm = null;
		}
	}

	function askKick(member: TeamMemberInfo) {
		pendingConfirm = {
			title: `${member.name} aus dem Team entfernen?`,
			text: "Die Person kann danach keine Berichte mehr senden. Um wieder beizutreten, braucht sie den Beitritts-Link.",
			action: "Entfernen",
			run: () => kickMember(member)
		};
	}

	function askClearSent(r: TeamReportStatus) {
		pendingConfirm = {
			title: "Markierung zurücknehmen?",
			text:
				r.payload === null
					? `${r.memberName} steht danach wieder als „kein Bericht“ in der Liste.`
					: `Der von ${r.memberName} gesendete Bericht wird hier gelöscht, die Person steht danach wieder als „kein Bericht“ in der Liste.`,
			action: "Zurücknehmen",
			run: () => clearSent(r.memberId)
		};
	}

	async function kickMember(member: TeamMemberInfo) {
		const teamId = chefTeams.selectedTeamId;
		if (!teamId) return;
		try {
			await account.revokeTeamMember(teamId, member.id);
			members = members.filter((m) => m.id !== member.id);
			toast.success(`${member.name} aus dem Team entfernt.`);
		} catch (e) {
			toast.error(`Entfernen fehlgeschlagen: ${errorText(e)}`);
		}
	}

	$effect(() => {
		if (account.linked) void chefTeams.loadTeams();
	});

	// ---------- Wer wann seinen Bericht gesendet hat ----------

	// Vormonat – der Monat, den ein Vorgesetzter auswertet.
	let month = $state(prevMonthKey());
	let reportsLoading = $state(false);
	let reports = $state<TeamReportStatus[]>([]);
	let drafting = $state(false);
	/** Aufgeklappte Zeilen - zeigen den gesendeten Inhalt. */
	let expanded = $state(new Set<string>());

	const label = $derived(monthLabel(month));
	const submitted = $derived(reports.filter((r) => r.submittedAt !== null));
	const missing = $derived(reports.filter((r) => r.submittedAt === null));
	/** Fehlende mit einer einzelnen, gültigen Adresse (bereinigt in `email`) – nur die lassen sich per Mail erinnern. */
	const reachableMissing = $derived(
		missing.flatMap((r) => {
			const email = cleanEmail(r.memberEmail);
			return email ? [{ ...r, email }] : [];
		})
	);

	/** Gegen dieselbe Verwechslungsgefahr wie membersRequest oben. */
	let reportsRequest = 0;

	async function loadReports(teamId: string, forMonth: string) {
		const requestId = ++reportsRequest;
		reportsLoading = true;
		try {
			const result = await account.listTeamReports(teamId, forMonth);
			if (requestId !== reportsRequest) return;
			reports = result;
		} catch (e) {
			if (requestId !== reportsRequest) return;
			toast.error(`Abgaben konnten nicht geladen werden: ${errorText(e)}`);
		} finally {
			if (requestId === reportsRequest) reportsLoading = false;
		}
	}

	$effect(() => {
		if (chefTeams.selectedTeamId) void loadReports(chefTeams.selectedTeamId, month);
		else reports = [];
	});

	function toggleExpanded(memberId: string) {
		expanded = new Set(expanded.has(memberId) ? [...expanded].filter((id) => id !== memberId) : [...expanded, memberId]);
	}

	let statusBusyId = $state<string | null>(null);

	/** Von Hand als gesendet markieren - für Berichte, die nicht über die App kamen. */
	async function markSent(memberId: string) {
		const teamId = chefTeams.selectedTeamId;
		if (!teamId || statusBusyId) return;
		statusBusyId = memberId;
		try {
			await account.markTeamReportSent(teamId, memberId, month);
			await loadReports(teamId, month);
			toast.success("Als gesendet markiert.");
		} catch (e) {
			toast.error(`Markieren fehlgeschlagen: ${errorText(e)}`);
		} finally {
			statusBusyId = null;
		}
	}

	/** Eine Markierung zurücknehmen - auch einen echten Upload, z.B. bei einem Versehen. */
	async function clearSent(memberId: string) {
		const teamId = chefTeams.selectedTeamId;
		if (!teamId || statusBusyId) return;
		const submittedAt = reports.find((r) => r.memberId === memberId)?.submittedAt;
		if (submittedAt == null) return;
		statusBusyId = memberId;
		try {
			await account.clearTeamReportStatus(teamId, memberId, month, submittedAt);
			await loadReports(teamId, month);
			toast.success("Markierung zurückgenommen.");
		} catch (e) {
			if (e instanceof ApiError && e.status === 409) {
				// Zwischen Laden und Klick ist ein neuerer, echter Bericht
				// eingetroffen - der Server hat das Löschen abgelehnt. Die
				// aktualisierte Ansicht zeigt ihn jetzt statt der veralteten Zeile.
				toast.error("Inzwischen ein neuer Bericht eingegangen - Ansicht aktualisiert.");
				await loadReports(teamId, month);
			} else {
				toast.error(`Zurücknehmen fehlgeschlagen: ${errorText(e)}`);
			}
		} finally {
			statusBusyId = null;
		}
	}

	/** Grobe Sicht auf payload - dem Transport nach unbekannt, in Wahrheit MonthReport (report/report.ts). */
	function reportRows(payload: unknown): { name: string; hours: number }[] {
		const rows = (payload as { rows?: unknown } | null)?.rows;
		if (!Array.isArray(rows)) return [];
		// Der Inhalt kommt vom Mitglieds-Client, ungeprüft - eine falsch geformte
		// Zeile darf die Ansicht nicht zum Absturz bringen.
		return rows.filter(
			(r): r is { name: string; hours: number } =>
				typeof r?.name === "string" && typeof r?.hours === "number"
		);
	}

	async function draftReminder() {
		if (drafting) return;
		drafting = true;
		try {
			// Alle Fehlenden in EINEN Entwurf; im Text steht kein Name, damit
			// niemand darin liest, wer sonst noch säumig ist.
			await createOutlookDraft(
				reachableMissing.map((r) => r.email).join("; "),
				teamReminderSubject(label),
				teamReminderHtml(label)
			);
			logInfo(`Chef-Modus: Erinnerung für ${month} erstellt`, { count: reachableMissing.length });
			toast.success("Outlook-Entwurf geöffnet. Bitte prüfen und senden.");
		} catch (e) {
			toast.error(await reportOutlookError("Chef-Modus: Erinnerung fehlgeschlagen", e));
		} finally {
			drafting = false;
		}
	}

	async function exportCsv() {
		try {
			const path = await save({
				defaultPath: `Team-Abgaben-${month}.csv`,
				filters: [{ name: "CSV", extensions: ["csv"] }]
			});
			if (!path) return;
			await invoke("write_export_file", { path, contents: teamReportsToCsv(reports) });
			toast.success("CSV gespeichert.");
		} catch (e) {
			logError("Chef-Modus: CSV-Export fehlgeschlagen", e);
			toast.error(`Export fehlgeschlagen: ${errorText(e)}`);
		}
	}
</script>

<div class="space-y-4">
	{#if !account.linked}
		<div class="rounded-lg border border-dashed p-10 text-center">
			<div class="bg-primary/10 text-primary mx-auto mb-3 flex size-12 items-center justify-center rounded-full">
				<CloudIcon class="size-6" />
			</div>
			<p class="text-foreground text-sm font-medium">Kein Konto verbunden</p>
			<p class="text-muted-foreground mx-auto mt-1 max-w-sm text-xs">
				Für ein Team brauchst du ein Konto – dort werden Beitritts-Link und gemeinsame Aktivitäten
				gespeichert.
			</p>
			<Button size="sm" class="mt-4" onclick={() => tabFocus.requestSettings("konto")}>
				Zu den Konto-Einstellungen
			</Button>
		</div>
	{:else}
		{#if chefTeams.teamsLoading && chefTeams.teams.length === 0}
			<Card.Root>
				<Card.Header>
					<Skeleton class="h-5 w-32" />
				</Card.Header>
				<Card.Content class="space-y-2">
					<Skeleton class="h-4 w-full" />
					<Skeleton class="h-4 w-2/3" />
				</Card.Content>
			</Card.Root>
		{:else if chefTeams.teamsLoadFailed && chefTeams.teams.length === 0}
			<div class="rounded-lg border border-dashed p-10 text-center">
				<div class="bg-muted text-muted-foreground mx-auto mb-3 flex size-12 items-center justify-center rounded-full">
					<CloudIcon class="size-6" />
				</div>
				<p class="text-foreground text-sm font-medium">Teams konnten gerade nicht geladen werden</p>
				<p class="text-muted-foreground mx-auto mt-1 max-w-sm text-xs">
					Vermutlich besteht keine Internetverbindung. Deine Teams sind nicht verloren.
				</p>
				<Button size="sm" variant="outline" class="mt-4" onclick={() => void chefTeams.loadTeams()}>
					<RefreshCwIcon class="size-4" /> Erneut versuchen
				</Button>
			</div>
		{:else if chefTeams.teams.length === 0}
			<div class="rounded-lg border border-dashed p-10 text-center">
				<div class="bg-primary/10 text-primary mx-auto mb-3 flex size-12 items-center justify-center rounded-full">
					<UsersIcon class="size-6" />
				</div>
				<p class="text-foreground text-sm font-medium">Noch kein Team angelegt</p>
				<p class="text-muted-foreground mx-auto mt-1 max-w-sm text-xs">
					Lege ein Team an, um Mitglieder per Link einzuladen und ihre Monatsberichte an einem
					Ort zu sehen.
				</p>
				<Button size="sm" class="mt-4" onclick={() => tabFocus.requestSettings("team")}>
					<PlusIcon class="size-4" /> Team anlegen
				</Button>
			</div>
		{:else}
			<Card.Root>
				<Card.Header>
					<Card.Title>
						{#if chefTeams.teams.length > 1}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger
									class={cn(
										buttonVariants({ variant: "ghost", size: "sm" }),
										"h-auto gap-1 px-1.5 text-base font-medium"
									)}
								>
									{chefTeams.selectedTeam?.name ?? "Team wählen"}
									<ChevronDownIcon class="text-muted-foreground size-4" />
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="start">
									{#each chefTeams.teams as t (t.id)}
										<DropdownMenu.Item onSelect={() => (chefTeams.selectedTeamId = t.id)}>
											{t.name}
										</DropdownMenu.Item>
									{/each}
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						{:else}
							{chefTeams.selectedTeam?.name ?? "Team"}
						{/if}
					</Card.Title>
					<Card.Action>
						<div class="flex flex-wrap gap-2">
							<Popover.Root>
								<Popover.Trigger class={buttonVariants({ variant: "outline", size: "sm" })}>
									<UserPlusIcon class="size-4" /> Einladen
								</Popover.Trigger>
								<Popover.Content align="end" class="w-72 space-y-2">
									<p class="text-muted-foreground text-xs">Beitritts-Link</p>
									{#if chefTeams.inviteLoading}
										<p class="text-muted-foreground text-sm">Wird geladen…</p>
									{:else if chefTeams.inviteUrl}
										<div class="flex items-center gap-2">
											<code class="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 text-xs">{chefTeams.inviteUrl}</code>
											<Button variant="ghost" size="icon-sm" title="Link kopieren" onclick={() => chefTeams.copyInviteUrl()}>
												<CopyIcon class="size-4" />
											</Button>
										</div>
									{:else}
										<p class="text-muted-foreground text-xs">
											Noch keinen Link erzeugt.
											<Button
												variant="link"
												class="h-auto p-0 text-xs"
												onclick={() => tabFocus.requestSettings("team")}
											>
												In den Einstellungen erzeugen
											</Button>
										</p>
									{/if}
								</Popover.Content>
							</Popover.Root>
							<Button variant="outline" size="sm" onclick={() => tabFocus.request("activities")}>
								<LayersIcon class="size-4" /> Aktivitäten
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								onclick={() => tabFocus.requestSettings("team")}
								title="Team anlegen, Beitritts-Link und Verwalter"
							>
								<SettingsIcon class="size-4" />
							</Button>
						</div>
					</Card.Action>
				</Card.Header>

				<Card.Content class="space-y-2 border-t pt-4">
					<p class="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
						Mitglieder ({members.length})
					</p>
					{#if members.length === 0}
						<div class="rounded-lg border border-dashed p-6 text-center">
							<UserPlusIcon class="text-muted-foreground/50 mx-auto mb-2 size-8" />
							<p class="text-foreground text-sm font-medium">Noch niemand beigetreten</p>
							<p class="text-muted-foreground mt-0.5 text-xs">
								Lade Mitglieder über „Einladen“ oben ein.
							</p>
						</div>
					{:else}
						<Table.Root>
							<Table.Header>
								<Table.Row>
									<Table.Head>Name</Table.Head>
									<Table.Head>Beigetreten</Table.Head>
									<Table.Head class="w-10"></Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each members as m (m.id)}
									<Table.Row>
										<Table.Cell class="font-medium">
											<div class="flex items-center gap-2.5">
												<div class="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold uppercase">
													{m.name.slice(0, 1)}
												</div>
												{m.name}
											</div>
										</Table.Cell>
										<Table.Cell class="text-muted-foreground text-sm">
											{fmtDateHuman(m.createdAt)}
										</Table.Cell>
										<Table.Cell>
											<Button
												variant="ghost"
												size="icon-sm"
												title="Aus dem Team entfernen"
												aria-label="{m.name} aus dem Team entfernen"
												onclick={() => askKick(m)}
											>
												<Trash2Icon class="size-4" />
											</Button>
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					{/if}
				</Card.Content>
			</Card.Root>
		{/if}

		{#if chefTeams.selectedTeamId}
			<div class="flex flex-wrap items-end justify-between gap-3">
				<MonthSelector bind:month id="tmonth" />
				<div class="flex flex-wrap gap-2">
					{#if isTauri()}
						<Button variant="outline" onclick={exportCsv} disabled={reports.length === 0}>
							<DownloadIcon class="size-4" /> CSV
						</Button>
					{/if}
					{#if capabilities.outlook && reachableMissing.length > 0}
						<Button variant="outline" onclick={draftReminder} disabled={drafting}>
							<BellIcon class="size-4" /> Fehlende erinnern ({reachableMissing.length})
						</Button>
					{/if}
				</div>
			</div>

			<Card.Root>
				<Card.Header>
					<Card.Title>{label}</Card.Title>
					<Card.Description>Wer seinen Bericht über die App gesendet hat.</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-4 px-0">
					{#if reportsLoading}
						<p class="text-muted-foreground px-4 text-sm">Wird geladen…</p>
					{:else if reports.length === 0}
						<div class="mx-4 rounded-lg border border-dashed p-6 text-center">
							<UsersIcon class="text-muted-foreground/50 mx-auto mb-2 size-8" />
							<p class="text-foreground text-sm font-medium">Noch niemand im Team</p>
							<p class="text-muted-foreground mt-0.5 text-xs">
								Sobald Mitglieder beigetreten sind, erscheinen ihre Abgaben hier.
							</p>
						</div>
					{:else}
						<div class="grid grid-cols-2 gap-3 px-4">
							<StatTile label="Abgegeben">{submitted.length}</StatTile>
							<StatTile
								label="Ausstehend"
								valueClass={missing.length === 0 ? "text-muted-foreground" : "text-destructive"}
							>
								{missing.length}
							</StatTile>
						</div>
						<Table.Root>
							<Table.Header>
								<Table.Row>
									<Table.Head class="min-w-48">Mitarbeiter</Table.Head>
									<Table.Head>Status</Table.Head>
									<Table.Head class="text-right">Eingegangen</Table.Head>
									<Table.Head class="w-10"></Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each submitted as r (r.memberId)}
									<Table.Row class="cursor-pointer" onclick={() => toggleExpanded(r.memberId)}>
										<Table.Cell class="font-medium">
											<button
												type="button"
												class="flex items-center gap-1.5 text-left"
												aria-expanded={expanded.has(r.memberId)}
												onclick={(e) => {
													e.stopPropagation();
													toggleExpanded(r.memberId);
												}}
											>
												<ChevronDownIcon
													class="size-3.5 shrink-0 transition-transform {expanded.has(r.memberId) ? '' : '-rotate-90'}"
												/>
												{r.memberName}
											</button>
										</Table.Cell>
										<Table.Cell>
											<div class="flex flex-wrap items-center gap-1.5">
												<Badge
													variant="outline"
													class="border-green-600/40 bg-green-500/10 whitespace-nowrap text-green-700 dark:text-green-400"
												>
													<CheckIcon /> abgegeben
												</Badge>
												{#if r.payload === null}
													<Badge variant="secondary" title="Von Hand als gesendet markiert, kein Inhalt">
														von Hand
													</Badge>
												{/if}
											</div>
										</Table.Cell>
										<Table.Cell class="text-right text-sm whitespace-nowrap">
											{fmtDateHuman(r.submittedAt!)}, {fmtClock(r.submittedAt!)}
										</Table.Cell>
										<Table.Cell>
											<Button
												variant="ghost"
												size="icon-sm"
												title="Markierung zurücknehmen"
												aria-label="Markierung für {r.memberName} zurücknehmen"
												disabled={statusBusyId !== null}
												onclick={(e) => {
													e.stopPropagation();
													askClearSent(r);
												}}
											>
												<XIcon class="size-4" />
											</Button>
										</Table.Cell>
									</Table.Row>
									{#if expanded.has(r.memberId)}
										{@const rows = reportRows(r.payload)}
										<Table.Row>
											<Table.Cell colspan={4} class="bg-muted/30">
												{#if rows.length === 0}
													<p class="text-muted-foreground text-xs">Kein Inhalt verfügbar.</p>
												{:else}
													<ul class="text-sm">
														{#each rows as row, i (i)}
															<li class="flex justify-between gap-4">
																<span>{row.name}</span>
																<span class="text-muted-foreground">{fmtHours(row.hours)} h</span>
															</li>
														{/each}
													</ul>
												{/if}
											</Table.Cell>
										</Table.Row>
									{/if}
								{/each}
								{#each missing as r (r.memberId)}
									<Table.Row class="opacity-70">
										<Table.Cell class="font-medium">{r.memberName}</Table.Cell>
										<Table.Cell>
											<Badge
												variant="outline"
												class="border-destructive/40 bg-destructive/10 text-destructive whitespace-nowrap"
											>
												kein Bericht
											</Badge>
										</Table.Cell>
										<Table.Cell class="text-muted-foreground text-right">—</Table.Cell>
										<Table.Cell>
											<Button
												variant="ghost"
												size="icon-sm"
												title="Von Hand als gesendet markieren"
												aria-label="{r.memberName} von Hand als gesendet markieren"
												disabled={statusBusyId !== null}
												onclick={() => markSent(r.memberId)}
											>
												<CheckIcon class="size-4" />
											</Button>
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					{/if}
				</Card.Content>
			</Card.Root>
		{/if}
	{/if}
</div>

<Dialog.Root
	open={pendingConfirm !== null}
	onOpenChange={(o) => {
		if (!o && !confirmBusy) pendingConfirm = null;
	}}
>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{pendingConfirm?.title}</Dialog.Title>
			<Dialog.Description>{pendingConfirm?.text}</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" disabled={confirmBusy} onclick={() => (pendingConfirm = null)}>Abbrechen</Button>
			<Button variant="destructive" disabled={confirmBusy} onclick={runConfirmed}>
				{pendingConfirm?.action}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
