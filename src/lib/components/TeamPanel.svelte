<script lang="ts">
	import { invoke } from "@tauri-apps/api/core";
	import { save } from "@tauri-apps/plugin-dialog";
	import { account } from "$lib/sync/account.svelte";
	import type {
		TeamActivity,
		TeamActivityInput,
		TeamInfo,
		TeamInvite,
		TeamMemberInfo,
		TeamReportStatus
	} from "$lib/sync/api";
	import { createOutlookDraft, reportOutlookError } from "$lib/report/outlook";
	import { teamReminderHtml, teamReminderSubject, teamReportsToCsv } from "$lib/report/teamReport";
	import { fmtClock, fmtDateHuman, monthLabel, prevMonthKey } from "$lib/time/time";
	import { errorText, logError, logInfo } from "$lib/log";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import MonthSelector from "$lib/components/shared/MonthSelector.svelte";
	import StatTile from "$lib/components/shared/StatTile.svelte";
	import * as Card from "$lib/components/ui/card";
	import * as Table from "$lib/components/ui/table";
	import * as Select from "$lib/components/ui/select";
	import { toast } from "svelte-sonner";
	import DownloadIcon from "@lucide/svelte/icons/download";
	import BellIcon from "@lucide/svelte/icons/bell";
	import CheckIcon from "@lucide/svelte/icons/check";
	import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
	import CopyIcon from "@lucide/svelte/icons/copy";
	import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";
	import PlusIcon from "@lucide/svelte/icons/plus";
	import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
	import XIcon from "@lucide/svelte/icons/x";

	// ---------- Team verwalten (Link, Aktivitäten, Roster) ----------

	let teams = $state<TeamInfo[]>([]);
	let selectedTeamId = $state<string | undefined>(undefined);
	let teamsLoading = $state(false);
	let newTeamName = $state("");
	let creatingTeam = $state(false);

	let invite = $state<TeamInvite | null>(null);
	let inviteLoading = $state(false);
	let rotatingInvite = $state(false);
	let members = $state<TeamMemberInfo[]>([]);

	let activities = $state<TeamActivityInput[]>([]);
	let savingActivities = $state(false);

	const selectedTeam = $derived(teams.find((t) => t.id === selectedTeamId) ?? null);
	const inviteUrl = $derived(invite ? `${account.serverUrl}/team/join/${invite.code}` : null);

	async function loadTeams() {
		if (!account.linked) return;
		teamsLoading = true;
		try {
			teams = await account.listTeams();
			if (!selectedTeamId || !teams.some((t) => t.id === selectedTeamId)) {
				selectedTeamId = teams[0]?.id;
			}
		} catch (e) {
			toast.error(`Teams konnten nicht geladen werden: ${errorText(e)}`);
		} finally {
			teamsLoading = false;
		}
	}

	async function loadTeamDetails(teamId: string) {
		inviteLoading = true;
		try {
			const [inv, mem, act] = await Promise.all([
				account.getTeamInvite(teamId),
				account.listTeamMembers(teamId),
				account.listTeamActivities(teamId)
			]);
			invite = inv;
			members = mem;
			activities = act;
		} catch (e) {
			toast.error(`Team konnte nicht geladen werden: ${errorText(e)}`);
		} finally {
			inviteLoading = false;
		}
	}

	$effect(() => {
		if (selectedTeamId) void loadTeamDetails(selectedTeamId);
		else {
			invite = null;
			members = [];
			activities = [];
		}
	});

	async function saveActivities() {
		if (!selectedTeamId || savingActivities) return;
		const cleaned = activities
			.map((a, i) => ({ ...a, name: a.name.trim(), sortOrder: i }))
			.filter((a) => a.name);
		savingActivities = true;
		try {
			activities = (await account.setTeamActivities(selectedTeamId, cleaned)) as TeamActivity[];
			toast.success("Gemeinsame Aktivitäten gespeichert.");
		} catch (e) {
			toast.error(`Speichern fehlgeschlagen: ${errorText(e)}`);
		} finally {
			savingActivities = false;
		}
	}

	async function createTeam() {
		const name = newTeamName.trim();
		if (!name || creatingTeam) return;
		creatingTeam = true;
		try {
			const team = await account.createTeam(name);
			logInfo(`Team angelegt: ${name}`);
			newTeamName = "";
			teams = [team, ...teams];
			selectedTeamId = team.id;
		} catch (e) {
			toast.error(`Team konnte nicht angelegt werden: ${errorText(e)}`);
		} finally {
			creatingTeam = false;
		}
	}

	async function rotateInvite() {
		if (!selectedTeamId || rotatingInvite) return;
		rotatingInvite = true;
		try {
			invite = await account.rotateTeamInvite(selectedTeamId);
			logInfo(`Team-Link erneuert: ${selectedTeam?.name}`);
		} catch (e) {
			toast.error(`Link konnte nicht erzeugt werden: ${errorText(e)}`);
		} finally {
			rotatingInvite = false;
		}
	}

	async function copyInviteUrl() {
		if (!inviteUrl) return;
		try {
			await navigator.clipboard.writeText(inviteUrl);
			toast.success("Link kopiert.");
		} catch {
			toast.error("Kopieren nicht möglich – bitte manuell kopieren.");
		}
	}

	async function kickMember(member: TeamMemberInfo) {
		if (!selectedTeamId) return;
		try {
			await account.revokeTeamMember(selectedTeamId, member.id);
			members = members.filter((m) => m.id !== member.id);
			toast.success(`${member.name} aus dem Team entfernt.`);
		} catch (e) {
			toast.error(`Entfernen fehlgeschlagen: ${errorText(e)}`);
		}
	}

	$effect(() => {
		if (account.linked) void loadTeams();
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
	/** Fehlende mit Adresse – nur die lassen sich per Mail erinnern. */
	const reachableMissing = $derived(missing.filter((r) => r.memberEmail));

	async function loadReports(teamId: string, forMonth: string) {
		reportsLoading = true;
		try {
			reports = await account.listTeamReports(teamId, forMonth);
		} catch (e) {
			toast.error(`Abgaben konnten nicht geladen werden: ${errorText(e)}`);
		} finally {
			reportsLoading = false;
		}
	}

	$effect(() => {
		if (selectedTeamId) void loadReports(selectedTeamId, month);
		else reports = [];
	});

	function toggleExpanded(memberId: string) {
		expanded = new Set(expanded.has(memberId) ? [...expanded].filter((id) => id !== memberId) : [...expanded, memberId]);
	}

	let statusBusyId = $state<string | null>(null);

	/** Von Hand als gesendet markieren - für Berichte, die nicht über die App kamen. */
	async function markSent(memberId: string) {
		if (!selectedTeamId || statusBusyId) return;
		statusBusyId = memberId;
		try {
			await account.markTeamReportSent(selectedTeamId, memberId, month);
			await loadReports(selectedTeamId, month);
			toast.success("Als gesendet markiert.");
		} catch (e) {
			toast.error(`Markieren fehlgeschlagen: ${errorText(e)}`);
		} finally {
			statusBusyId = null;
		}
	}

	/** Eine Markierung zurücknehmen - auch einen echten Upload, z.B. bei einem Versehen. */
	async function clearSent(memberId: string) {
		if (!selectedTeamId || statusBusyId) return;
		statusBusyId = memberId;
		try {
			await account.clearTeamReportStatus(selectedTeamId, memberId, month);
			await loadReports(selectedTeamId, month);
			toast.success("Markierung zurückgenommen.");
		} catch (e) {
			toast.error(`Zurücknehmen fehlgeschlagen: ${errorText(e)}`);
		} finally {
			statusBusyId = null;
		}
	}

	/** Grobe Sicht auf payload - dem Transport nach unbekannt, in Wahrheit MonthReport (report/report.ts). */
	function reportRows(payload: unknown): { name: string; hours: number }[] {
		const rows = (payload as { rows?: { name: string; hours: number }[] } | null)?.rows;
		return Array.isArray(rows) ? rows : [];
	}

	async function draftReminder() {
		if (drafting) return;
		drafting = true;
		try {
			// Alle Fehlenden in EINEN Entwurf; im Text steht kein Name, damit
			// niemand darin liest, wer sonst noch säumig ist.
			await createOutlookDraft(
				reachableMissing.map((r) => r.memberEmail).join("; "),
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
		<Card.Root>
			<Card.Content class="text-muted-foreground py-4 text-sm">
				Team-Verwaltung braucht ein Konto (Tab „Einstellungen“ → Konto) - der Link und die
				gemeinsamen Aktivitäten liegen dort, nicht nur auf diesem Gerät.
			</Card.Content>
		</Card.Root>
	{:else}
		<Card.Root>
			<Card.Header>
				<Card.Title>Team</Card.Title>
				<Card.Description>
					Mitglieder treten über einen Link bei - ohne eigenes Konto. Der Link führt zu den
					gemeinsamen Aktivitäten und meldet, wann von dort ein Bericht gesendet wurde.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<div class="flex flex-wrap items-end gap-2">
					{#if teams.length > 0}
						<Select.Root type="single" bind:value={selectedTeamId}>
							<Select.Trigger class="w-56">
								{selectedTeam?.name ?? "Team wählen"}
							</Select.Trigger>
							<Select.Content>
								{#each teams as t (t.id)}
									<Select.Item value={t.id} label={t.name}>{t.name}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					{:else if teamsLoading}
						<p class="text-muted-foreground text-sm">Teams werden geladen…</p>
					{:else}
						<p class="text-muted-foreground text-sm">Noch kein Team angelegt.</p>
					{/if}
					<Input
						bind:value={newTeamName}
						placeholder="Neues Team, z.B. „Vertrieb“"
						class="w-56"
						onkeydown={(e) => e.key === "Enter" && createTeam()}
					/>
					<Button variant="outline" disabled={!newTeamName.trim() || creatingTeam} onclick={createTeam}>
						<PlusIcon class="size-4" /> Anlegen
					</Button>
				</div>

				{#if selectedTeamId}
					<div class="space-y-2 border-t pt-4">
						<Label>Beitritts-Link</Label>
						{#if inviteLoading}
							<p class="text-muted-foreground text-sm">Wird geladen…</p>
						{:else}
							<div class="flex flex-wrap items-center gap-2">
								{#if inviteUrl}
									<code class="bg-muted rounded px-2 py-1 text-xs break-all">{inviteUrl}</code>
									<Button variant="ghost" size="icon-sm" title="Link kopieren" onclick={copyInviteUrl}>
										<CopyIcon class="size-4" />
									</Button>
								{/if}
								<Button variant="outline" size="sm" disabled={rotatingInvite} onclick={rotateInvite}>
									<RefreshCwIcon class="size-4" />
									{invite ? "Neuen Link erzeugen" : "Link erzeugen"}
								</Button>
							</div>
							<p class="text-muted-foreground text-xs">
								Ein neuer Link macht den bisherigen ungültig - schon beigetretene Mitglieder bleiben
								davon unberührt.
							</p>
						{/if}
					</div>

					<div class="space-y-2 border-t pt-4">
						<Label>Mitglieder ({members.length})</Label>
						{#if members.length === 0}
							<p class="text-muted-foreground text-sm">Noch niemand beigetreten.</p>
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
											<Table.Cell class="font-medium">{m.name}</Table.Cell>
											<Table.Cell class="text-muted-foreground text-sm">
												{fmtDateHuman(m.createdAt)}
											</Table.Cell>
											<Table.Cell>
												<Button
													variant="ghost"
													size="icon-sm"
													title="Aus dem Team entfernen"
													onclick={() => kickMember(m)}
												>
													<Trash2Icon class="size-4" />
												</Button>
											</Table.Cell>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						{/if}
					</div>

					<div class="space-y-2 border-t pt-4">
						<Label>Gemeinsame Aktivitäten</Label>
						<p class="text-muted-foreground text-xs leading-relaxed">
							Erscheinen auf den Geräten aller Mitglieder - dort nur änderbar von hier aus.
						</p>
						{#each activities as a, i (i)}
							<div class="flex gap-2">
								<Input placeholder="Name" bind:value={activities[i].name} />
								<Button
									variant="ghost"
									size="icon"
									title="Entfernen"
									onclick={() => (activities = activities.filter((_, j) => j !== i))}
								>
									<Trash2Icon class="size-4" />
								</Button>
							</div>
						{/each}
						<div class="flex flex-wrap gap-2">
							<Button
								variant="outline"
								size="sm"
								onclick={() =>
									(activities = [
										...activities,
										{ name: "", isAbsence: false, sortOrder: activities.length, archived: false }
									])}
							>
								<PlusIcon class="size-4" /> Aktivität
							</Button>
							<Button size="sm" disabled={savingActivities} onclick={saveActivities}>
								{savingActivities ? "Wird gespeichert…" : "Speichern"}
							</Button>
						</div>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		{#if selectedTeamId}
			<div class="flex flex-wrap items-end justify-between gap-3">
				<MonthSelector bind:month id="tmonth" />
				<div class="flex flex-wrap gap-2">
					<Button variant="outline" onclick={exportCsv} disabled={reports.length === 0}>
						<DownloadIcon class="size-4" /> CSV
					</Button>
					{#if reachableMissing.length > 0}
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
						<p class="text-muted-foreground px-4 text-sm">Noch niemand im Team.</p>
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
											<div class="flex items-center gap-1.5">
												<ChevronDownIcon
													class="size-3.5 shrink-0 transition-transform {expanded.has(r.memberId) ? '' : '-rotate-90'}"
												/>
												{r.memberName}
											</div>
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
													<Badge variant="secondary" title="Vom Chef von Hand markiert, kein Inhalt">
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
												disabled={statusBusyId === r.memberId}
												onclick={(e) => {
													e.stopPropagation();
													clearSent(r.memberId);
												}}
											>
												<XIcon class="size-4" />
											</Button>
										</Table.Cell>
									</Table.Row>
									{#if expanded.has(r.memberId)}
										<Table.Row>
											<Table.Cell colspan={4} class="bg-muted/30">
												{#if reportRows(r.payload).length === 0}
													<p class="text-muted-foreground text-xs">Kein Inhalt verfügbar.</p>
												{:else}
													<ul class="text-sm">
														{#each reportRows(r.payload) as row}
															<li class="flex justify-between gap-4">
																<span>{row.name}</span>
																<span class="text-muted-foreground">{row.hours.toFixed(2)} h</span>
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
												disabled={statusBusyId === r.memberId}
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
