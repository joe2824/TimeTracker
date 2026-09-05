<script lang="ts">
	import { invoke } from "@tauri-apps/api/core";
	import { save } from "@tauri-apps/plugin-dialog";
	import { app } from "$lib/app.svelte";
	import {
		createOutlookDraft,
		readOutlookMails,
		reportOutlookError,
		type OutlookMail
	} from "$lib/report/outlook";
	import {
		buildTeamSummary,
		scanRange,
		teamReminderHtml,
		teamReminderSubject,
		teamSummaryToCsv
	} from "$lib/report/teamReport";
	import { fmtClock, fmtDateHuman, prevMonthKey } from "$lib/time/time";
	import { errorText, logError, logInfo } from "$lib/log";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import MonthSelector from "$lib/components/shared/MonthSelector.svelte";
	import StatTile from "$lib/components/shared/StatTile.svelte";
	import * as Card from "$lib/components/ui/card";
	import * as Table from "$lib/components/ui/table";
	import { toast } from "svelte-sonner";
	import InboxIcon from "@lucide/svelte/icons/inbox";
	import DownloadIcon from "@lucide/svelte/icons/download";
	import BellIcon from "@lucide/svelte/icons/bell";
	import UserPlusIcon from "@lucide/svelte/icons/user-plus";
	import CheckIcon from "@lucide/svelte/icons/check";
	import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";

	// Vormonat – der Monat, den ein Vorgesetzter auswertet.
	let month = $state(prevMonthKey());
	let loading = $state(false);
	let scanned = $state<string | null>(null);
	let mails = $state<OutlookMail[]>([]);
	let drafting = $state(false);

	const summary = $derived(
		buildTeamSummary(month, mails, app.settings.team, app.settings.teamSubjectFilter)
	);
	const range = $derived(scanRange(month));
	/**
	 * Gefundene Mails, die einen anderen Monat betreffen. Der Filter greift ueber
	 * den Betreff, der Zeitraum ueber das Empfangsdatum – wer seinen Januar-Bericht
	 * im Maerz nachreicht, taucht deshalb im Posteingang auf, aber nicht in dieser
	 * Tabelle. Ungenannt wirkt das wie ein verschluckter Bericht.
	 */
	const otherMonth = $derived(Math.max(0, mails.length - summary.entries.length));
	/** Fehlende mit Adresse – nur die lassen sich erinnern. */
	const reachableMissing = $derived(summary.missing.filter((m) => m.email.trim()));

	// Ein Ergebnis gilt fuer den Monat, fuer den es geholt wurde. Ohne dieses
	// Zuruecksetzen stuende nach dem Umschalten die Ausbeute des Vormonats unter
	// der neuen Monatsueberschrift – gefiltert, also plausibel leer, aber falsch.
	$effect(() => {
		if (scanned !== null && scanned !== month) {
			mails = [];
			scanned = null;
		}
	});

	async function scan() {
		if (loading) return;
		loading = true;
		try {
			const found = await readOutlookMails(
				range.start,
				range.end,
				app.settings.teamSubjectFilter,
				app.settings.teamScanSubfolders
			);
			mails = found;
			scanned = month;
			logInfo(`Chef-Modus: Posteingang für ${month} gelesen`, {
				wasFound: found.length,
				fromDate: range.start,
				toDate: range.end,
				subjectLine: app.settings.teamSubjectFilter
			});
			if (found.length === 0) {
				toast.info("Keine passende Mail gefunden.", {
					description: `Gesucht wurde vom ${range.start} bis ${range.end} nach „${app.settings.teamSubjectFilter}" im Betreff.`
				});
			}
		} catch (e) {
			const msg = await reportOutlookError("Chef-Modus: Posteingang konnte nicht gelesen werden", e);
			toast.error(`Posteingang konnte nicht gelesen werden: ${msg}`);
		} finally {
			loading = false;
		}
	}

	/** Einen Absender, der noch nicht im Team steht, dort aufnehmen. */
	async function addToTeam(name: string, email: string) {
		if (!email.trim()) {
			toast.error("Ohne E-Mail-Adresse lässt sich niemand zuordnen.");
			return;
		}
		await app.updateSettings({
			team: [...app.settings.team, { id: crypto.randomUUID(), name: name.trim(), email: email.trim() }]
		});
		toast.success(`${name} zum Team hinzugefügt.`);
	}

	async function draftReminder() {
		if (drafting) return;
		drafting = true;
		try {
			// Alle Fehlenden in EINEN Entwurf; im Text steht kein Name, damit
			// niemand darin liest, wer sonst noch säumig ist.
			await createOutlookDraft(
				reachableMissing.map((m) => m.email).join("; "),
				teamReminderSubject(summary.label),
				teamReminderHtml(summary.label)
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
			await invoke("write_export_file", { path, contents: teamSummaryToCsv(summary) });
			toast.success("CSV gespeichert.");
		} catch (e) {
			logError("Chef-Modus: CSV-Export fehlgeschlagen", e);
			toast.error(`Export fehlgeschlagen: ${errorText(e)}`);
		}
	}
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<MonthSelector bind:month id="tmonth" />
		<div class="flex flex-wrap gap-2">
			{#if scanned === month}
				<Button variant="outline" onclick={exportCsv}>
					<DownloadIcon class="size-4" /> CSV
				</Button>
				{#if reachableMissing.length > 0}
					<Button variant="outline" onclick={draftReminder} disabled={drafting}>
						<BellIcon class="size-4" /> Fehlende erinnern ({reachableMissing.length})
					</Button>
				{/if}
			{/if}
			<Button variant={scanned === month ? "outline" : "default"} onclick={scan} disabled={loading}>
				{#if loading}<LoaderCircleIcon class="size-4 animate-spin" />{:else}<InboxIcon class="size-4" />{/if}
				{loading ? "Lese Posteingang…" : scanned === month ? "Neu einlesen" : "Berichte einlesen"}
			</Button>
		</div>
	</div>

	{#if app.settings.team.length === 0}
		<Card.Root>
			<Card.Content class="text-muted-foreground py-4 text-sm">
				Noch kein Team hinterlegt (Tab „Einstellungen“ → Chef-Modus). Ohne Teamliste lässt sich
				nicht erkennen, wessen Bericht fehlt – gefundene Absender kannst du unten direkt übernehmen.
			</Card.Content>
		</Card.Root>
	{/if}

	{#if loading}
		<Card.Root>
			<Card.Content class="space-y-2 py-6">
				<div class="text-muted-foreground flex items-center gap-2 text-sm">
					<LoaderCircleIcon class="size-4 shrink-0 animate-spin" />
					Posteingang wird gelesen ({range.start} bis {range.end})… Das klassische Outlook kann beim
					ersten Zugriff kurz brauchen.
				</div>
				<div class="bg-muted h-1.5 w-full overflow-hidden rounded-full">
					<div
						class="bg-primary h-full w-1/3 animate-[indeterminate_1.1s_ease-in-out_infinite] rounded-full"
					></div>
				</div>
			</Card.Content>
		</Card.Root>
	{:else if scanned !== month}
		<Card.Root>
			<Card.Header>
				<Card.Title>Abgaben des Teams prüfen</Card.Title>
				<Card.Description>
					Liest den Posteingang{app.settings.teamScanSubfolders ? " samt Unterordnern" : ""} vom
					{range.start} bis {range.end} und listet auf, wer seinen Bericht geschickt hat und wer
					nicht. Es wird ausschließlich gelesen – Stunden wertet die App dabei nicht aus.
				</Card.Description>
			</Card.Header>
		</Card.Root>
	{:else}
		<Card.Root>
			<Card.Header>
				<Card.Title>{summary.label}</Card.Title>
				<Card.Description>
					Gelesen wurde der Posteingang vom {range.start} bis {range.end}.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4 px-0">
				{#if summary.entries.length === 0 && summary.missing.length === 0}
					<p class="text-muted-foreground px-4 text-sm">Nichts gefunden.</p>
				{:else}
					<div class="grid grid-cols-2 gap-3 px-4 {otherMonth > 0 ? 'sm:grid-cols-3' : ''}">
						<StatTile label="Abgegeben">{summary.entries.length}</StatTile>
						<StatTile
							label="Ausstehend"
							valueClass={summary.missing.length === 0 ? "text-muted-foreground" : "text-destructive"}
						>
							{summary.missing.length}
						</StatTile>
						{#if otherMonth > 0}
							<!-- Mails, die der Filter fand, die aber einen anderen Monat betreffen.
							     Gehoert genannt: sonst wundert man sich, warum der Posteingang mehr
							     hergab als die Tabelle zeigt. -->
							<StatTile
								label="Anderer Monat"
								hint="gefunden, nicht gezählt"
								class="col-span-2 sm:col-span-1"
							>
								{otherMonth}
							</StatTile>
						{/if}
					</div>
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head class="min-w-48">Mitarbeiter</Table.Head>
								<Table.Head>Status</Table.Head>
								<Table.Head class="text-right">Eingegangen</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each summary.entries as e (e.key)}
								<Table.Row>
									<Table.Cell>
										<div class="flex flex-wrap items-center gap-1.5">
											<span class="font-medium">{e.name}</span>
											{#if e.monthSource === "received"}
												<Badge
													variant="outline"
													title="Kein Monat im Betreff – aus dem Empfangsdatum abgeleitet"
												>
													Monat geschätzt
												</Badge>
											{/if}
											{#if e.memberId === null}
												<Badge variant="secondary">nicht im Team</Badge>
												<Button
													variant="ghost"
													size="icon-sm"
													title="Zum Team hinzufügen"
													onclick={() => addToTeam(e.name, e.email)}
												>
													<UserPlusIcon class="size-4" />
												</Button>
											{/if}
										</div>
										{#if e.email}
											<div class="text-muted-foreground text-xs">{e.email}</div>
										{/if}
									</Table.Cell>
									<Table.Cell>
										<Badge
											variant="outline"
											class="border-green-600/40 bg-green-500/10 whitespace-nowrap text-green-700 dark:text-green-400"
										>
											<CheckIcon /> abgegeben
										</Badge>
									</Table.Cell>
									<Table.Cell class="text-right text-sm whitespace-nowrap">
										{fmtDateHuman(e.receivedTs)}, {fmtClock(e.receivedTs)}
									</Table.Cell>
								</Table.Row>
							{/each}
							{#each summary.missing as m (m.id)}
								<Table.Row class="opacity-70">
									<Table.Cell>
										<div class="font-medium">{m.name}</div>
										{#if m.email}
											<div class="text-muted-foreground text-xs">{m.email}</div>
										{/if}
									</Table.Cell>
									<Table.Cell>
										<Badge
											variant="outline"
											class="border-destructive/40 bg-destructive/10 text-destructive whitespace-nowrap"
										>
											kein Bericht
										</Badge>
									</Table.Cell>
									<Table.Cell class="text-muted-foreground text-right">—</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}
</div>
