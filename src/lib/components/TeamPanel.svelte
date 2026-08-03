<script lang="ts">
	// Chef-Modus: die eingegangenen Monatsberichte des Teams zu einer Uebersicht
	// zusammenziehen. Liest nur aus Outlook – nichts wird verschoben oder markiert.
	import { invoke } from "@tauri-apps/api/core";
	import { save } from "@tauri-apps/plugin-dialog";
	import { app } from "$lib/app.svelte";
	import {
		createOutlookDraft,
		detectOutlook,
		explainOutlookError,
		readOutlookMails,
		type OutlookMail
	} from "$lib/outlook";
	import {
		activityTotal,
		buildTeamSummary,
		hoursFor,
		scanRange,
		teamReminderHtml,
		teamReminderSubject,
		teamSummarySubject,
		teamSummaryToCsv,
		teamSummaryToHtml
	} from "$lib/teamReport";
	import { fmtDateHuman, fmtHoursClock } from "$lib/time";
	import { errorText, logError, logInfo } from "$lib/log";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import MonthSelector from "$lib/components/MonthSelector.svelte";
	import * as Card from "$lib/components/ui/card";
	import * as Table from "$lib/components/ui/table";
	import * as Dialog from "$lib/components/ui/dialog";
	import { toast } from "svelte-sonner";
	import MailIcon from "@lucide/svelte/icons/mail";
	import InboxIcon from "@lucide/svelte/icons/inbox";
	import DownloadIcon from "@lucide/svelte/icons/download";
	import EyeIcon from "@lucide/svelte/icons/eye";
	import BellIcon from "@lucide/svelte/icons/bell";
	import UserPlusIcon from "@lucide/svelte/icons/user-plus";
	import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";

	/**
	 * Vormonat – der Monat, den ein Vorgesetzter auswertet.
	 *
	 * Ueber den Monatsersten rechnen, nicht per setMonth() auf dem heutigen Datum:
	 * am 31. rollt "31. Juni" auf den 1. Juli, der Vormonat waere dort der aktuelle.
	 */
	function lastMonth(): string {
		const now = new Date();
		const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
	}

	let month = $state(lastMonth());
	let loading = $state(false);
	let scanned = $state<string | null>(null);
	let mails = $state<OutlookMail[]>([]);
	let previewOpen = $state(false);
	let drafting = $state(false);

	const summary = $derived(buildTeamSummary(month, mails, app.settings.team));
	const html = $derived(teamSummaryToHtml(summary));
	const range = $derived(scanRange(month));
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
				gefunden: found.length,
				von: range.start,
				bis: range.end,
				betreff: app.settings.teamSubjectFilter
			});
			if (found.length === 0) {
				toast.info("Keine passende Mail gefunden.", {
					description: `Gesucht wurde vom ${range.start} bis ${range.end} nach „${app.settings.teamSubjectFilter}" im Betreff.`
				});
			}
		} catch (e) {
			const info = await detectOutlook().catch(() => null);
			logError("Chef-Modus: Posteingang konnte nicht gelesen werden", {
				fehler: errorText(e),
				outlook: info
			});
			toast.error(`Posteingang konnte nicht gelesen werden: ${explainOutlookError(e, info)}`);
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

	async function draft(to: string, subject: string, body: string, was: string) {
		if (drafting) return;
		drafting = true;
		try {
			await createOutlookDraft(to, subject, body);
			logInfo(`Chef-Modus: Entwurf „${was}" für ${month} erstellt`, { an: to });
			toast.success("Outlook-Entwurf geöffnet. Bitte prüfen und senden.");
			previewOpen = false;
		} catch (e) {
			const info = await detectOutlook().catch(() => null);
			logError(`Chef-Modus: Entwurf „${was}" fehlgeschlagen`, {
				fehler: errorText(e),
				outlook: info
			});
			toast.error(explainOutlookError(e, info));
		} finally {
			drafting = false;
		}
	}

	function draftSummary() {
		return draft(
			app.settings.teamSummaryEmail,
			teamSummarySubject(summary.label),
			html,
			"Zusammenfassung"
		);
	}

	function draftReminder() {
		// Alle Fehlenden in EINEN Entwurf: als BCC-freie Sammelmail waere sichtbar,
		// wer sonst noch saeumig ist – deshalb steht im Text kein Name.
		return draft(
			reachableMissing.map((m) => m.email).join("; "),
			teamReminderSubject(summary.label),
			teamReminderHtml(summary.label),
			"Erinnerung"
		);
	}

	async function exportCsv() {
		try {
			const path = await save({
				defaultPath: `Team-Stunden-${month}.csv`,
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
				<Button variant="outline" onclick={() => (previewOpen = true)}>
					<EyeIcon class="size-4" /> Vorschau
				</Button>
				<Button onclick={draftSummary} disabled={drafting || summary.entries.length === 0}>
					<MailIcon class="size-4" /> Zusammenfassung
				</Button>
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

	<!-- Kam zu KEINER gefundenen Mail ein Inhalt an, liegt es nicht an den
	     Absendern, sondern an Outlook: manche Firmenrichtlinien geben per
	     Objektmodell nur Betreff und Empfangszeit heraus. Ohne diesen Hinweis
	     stuende eine Tabelle voller Nullen da, die aussieht, als haette das Team
	     nichts gearbeitet. -->
	{#if scanned === month && summary.bodiesMissing > 0}
		<Card.Root class="border-amber-500/50">
			<Card.Content class="space-y-1 py-4 text-sm">
				<p class="font-medium">
					{summary.bodiesMissing === summary.entries.length
						? "Outlook hat zu keiner Mail den Inhalt herausgegeben."
						: `Zu ${summary.bodiesMissing} von ${summary.entries.length} Mails fehlt der Inhalt.`}
				</p>
				<p class="text-muted-foreground">
					Wer abgegeben hat, steht trotzdem unten – nur die Stunden fehlen. Ursache ist meist eine
					Sicherheitsrichtlinie, die den programmatischen Zugriff auf Mail-Inhalte sperrt
					(erkennbar daran, dass auch Absendername und -adresse leer bleiben). Das lässt sich nicht
					in der App lösen – dafür muss die IT den Zugriff freigeben.
				</p>
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
				<Card.Title>Berichte des Teams einlesen</Card.Title>
				<Card.Description>
					Liest den Posteingang{app.settings.teamScanSubfolders ? " samt Unterordnern" : ""} vom
					{range.start} bis {range.end} und wertet alle Mails mit „{app.settings
						.teamSubjectFilter}“ im Betreff aus. Es wird ausschließlich gelesen.
				</Card.Description>
			</Card.Header>
		</Card.Root>
	{:else}
		<Card.Root>
			<Card.Header>
				<Card.Title>{summary.label}</Card.Title>
				<Card.Description>
					{summary.entries.length} Bericht{summary.entries.length === 1 ? "" : "e"}
					{#if summary.missing.length > 0}· {summary.missing.length} ausstehend{/if}
					· Gesamt {fmtHoursClock(summary.total)} h
					{#if mails.length > summary.entries.length}
						· {mails.length - summary.entries.length} Mail(s) betreffen einen anderen Monat
					{/if}
				</Card.Description>
			</Card.Header>
			<Card.Content class="px-0">
				{#if summary.entries.length === 0 && summary.missing.length === 0}
					<p class="text-muted-foreground px-6 text-sm">Nichts gefunden.</p>
				{:else}
					<div class="overflow-x-auto">
						<Table.Root>
							<Table.Header>
								<Table.Row>
									<Table.Head class="min-w-48">Mitarbeiter</Table.Head>
									{#each summary.activities as a (a)}
										<Table.Head class="text-right whitespace-nowrap">{a}</Table.Head>
									{/each}
									<Table.Head class="text-right">Summe</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each summary.entries as e (e.key)}
									<Table.Row>
										<Table.Cell>
											<div class="flex flex-wrap items-center gap-1.5">
												<span class="font-medium">{e.name}</span>
												{#if !e.hasBody}
													<Badge variant="outline" class="text-amber-600 dark:text-amber-400">
														Inhalt nicht geladen
													</Badge>
												{:else if !e.parsed}
													<Badge variant="outline" class="text-amber-600 dark:text-amber-400">
														Tabelle nicht lesbar
													</Badge>
												{/if}
												{#if e.monthSource === "received"}
													<Badge variant="outline" title="Kein Monat im Betreff – aus dem Empfangsdatum abgeleitet">
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
											<div class="text-muted-foreground text-xs">
												{e.email} · {fmtDateHuman(e.receivedTs)}
											</div>
										</Table.Cell>
										{#each summary.activities as a (a)}
											{@const h = hoursFor(e, a)}
											<Table.Cell class="text-right tabular-nums">
												{h > 0 ? fmtHoursClock(h) : ""}
											</Table.Cell>
										{/each}
										<Table.Cell class="text-right font-medium tabular-nums">
											{fmtHoursClock(e.total)}
										</Table.Cell>
									</Table.Row>
								{/each}
								{#each summary.missing as m (m.id)}
									<Table.Row class="opacity-70">
										<Table.Cell>
											<div class="font-medium">{m.name}</div>
											<div class="text-muted-foreground text-xs">{m.email}</div>
										</Table.Cell>
										{#each summary.activities as a (a)}
											<Table.Cell></Table.Cell>
										{/each}
										<Table.Cell class="text-right text-xs whitespace-nowrap text-red-600 dark:text-red-400">
											kein Bericht
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
							<Table.Footer>
								<Table.Row>
									<Table.Cell class="font-medium">Summe</Table.Cell>
									{#each summary.activities as a (a)}
										{@const h = activityTotal(summary, a)}
										<Table.Cell class="text-right font-medium tabular-nums">
											{h > 0 ? fmtHoursClock(h) : ""}
										</Table.Cell>
									{/each}
									<Table.Cell class="text-right font-medium tabular-nums">
										{fmtHoursClock(summary.total)}
									</Table.Cell>
								</Table.Row>
							</Table.Footer>
						</Table.Root>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}
</div>

<Dialog.Root bind:open={previewOpen}>
	<Dialog.Content class="sm:max-w-4xl">
		<Dialog.Header>
			<Dialog.Title>Vorschau · {summary.label}</Dialog.Title>
			<Dialog.Description>
				So erscheint die Zusammenfassung in der E-Mail. Fehlende Meldungen stehen mit drin.
			</Dialog.Description>
		</Dialog.Header>
		<!-- Feste helle Flaeche: die Tabelle traegt Inline-Styles fuer Outlook und
		     stuende im Dunkelmodus sonst schwarz auf dunkel. -->
		<div class="max-h-[60vh] overflow-auto rounded-md border bg-white p-4 text-black">
			<div class="mx-auto w-fit">
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				{@html html}
			</div>
		</div>
		<Dialog.Footer>
			<Button onclick={draftSummary} disabled={drafting || summary.entries.length === 0}>
				<MailIcon class="size-4" /> Outlook-Entwurf erstellen
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
