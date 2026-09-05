<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { buildReport, reportToHtml, reportToText } from "$lib/report";
	import { copyReportToClipboard, openMailWithReport, reportSubject } from "$lib/reportSend";
	import { fmtHoursClock } from "$lib/time";
	import { createOutlookDraft, reportOutlookError } from "$lib/outlook";
	import { capabilities } from "$lib/platform/env";
	import { logInfo } from "$lib/log";
	import { Button } from "$lib/components/ui/button";
	import MonthSelector from "$lib/components/shared/MonthSelector.svelte";
	import StatTile from "$lib/components/shared/StatTile.svelte";
	import StatsCard from "$lib/components/shared/StatsCard.svelte";
	import ArbZgCard from "$lib/components/shared/ArbZgCard.svelte";
	import * as Card from "$lib/components/ui/card";
	import * as Dialog from "$lib/components/ui/dialog";
	import { toast } from "svelte-sonner";
	import MailIcon from "@lucide/svelte/icons/mail";
	import CopyIcon from "@lucide/svelte/icons/copy";
	import EyeIcon from "@lucide/svelte/icons/eye";

	let month = $state(app.currentMonth);
	let sending = $state(false);
	let previewOpen = $state(false);

	$effect(() => {
		void app.ensureMonth(month);
	});

	const report = $derived(
		buildReport(
			month,
			app.activities,
			app.monthEntries(month),
			app.settings.rounding,
			app.settings.hoursPerDay,
			app.settings.workdays,
			// Bewusst Date.now() statt app.now: sonst haenge die Vorschau am
			// Sekundentakt und baute sich samt HTML jede Sekunde neu auf.
			Date.now(),
			app.settings.breakDeduction
		)
	);
	const html = $derived(reportToHtml(report));
	const subject = $derived(reportSubject(report.label));

	/** @returns true, wenn der Entwurf geoeffnet wurde. */
	async function sendToOutlook(): Promise<boolean> {
		sending = true;
		try {
			await createOutlookDraft(app.settings.bossEmail, subject, html);
			await app.markReportSent(month);
			logInfo(`Outlook-Entwurf für ${month} erstellt`, { to: app.settings.bossEmail });
			toast.success("Outlook-Entwurf geöffnet. Bitte prüfen und senden.");
			return true;
		} catch (e) {
			// Klar erklaeren (z.B. nur neues Outlook) und den mailto-Fallback anbieten.
			const msg = await reportOutlookError(`Outlook-Entwurf für ${month} fehlgeschlagen`, e);
			toast.error(msg, {
				description: "Fallback: Mail öffnen – die Tabelle liegt dann zum Einfügen bereit.",
				action: {
					label: "Mail öffnen",
					onClick: () => void prepareMail()
				}
			});
			return false;
		} finally {
			sending = false;
		}
	}

	/**
	 * Aktion aus der Vorschau heraus: nur bei Erfolg schliessen. Ging es schief, bleibt
	 * die Vorschau offen – man wollte ja genau von hier aus noch einmal ansetzen.
	 */
	async function fromPreview(action: () => Promise<boolean>) {
		if (await action()) previewOpen = false;
	}

	/** @returns true, wenn etwas Brauchbares in der Zwischenablage liegt. */
	async function copyHtml(): Promise<boolean> {
		const mode = await copyReportToClipboard(html, reportToText(report));
		if (mode === "rich") {
			toast.success("Tabelle kopiert – in Outlook mit Strg+V einfügen.");
		} else if (mode === "source") {
			toast.success("HTML-Quelltext kopiert.", {
				description: "Rich-Text wird von diesem System nicht unterstützt."
			});
		} else {
			toast.error("Kopieren fehlgeschlagen.");
		}
		return mode !== null;
	}

	/** Weg ohne Outlook – siehe openMailWithReport. */
	async function prepareMail(): Promise<boolean> {
		let mode;
		try {
			mode = await openMailWithReport(
				app.settings.bossEmail,
				subject,
				html,
				reportToText(report)
			);
		} catch (err) {
			toast.error(`Mailprogramm konnte nicht geöffnet werden: ${err}`);
			return false;
		}
		// Die Anleitung selbst steht im Entwurf - hier reicht die Rueckmeldung,
		// dass etwas passiert ist.
		if (mode === "rich") {
			toast.success("Die Tabelle wurde kopiert.");
		} else {
			toast.warning("Die Tabelle konnte nicht kopiert werden.", {
				description: "Die Mail wurde stattdessen als einfache Liste geöffnet."
			});
		}
		return true;
	}
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<MonthSelector bind:month id="rmonth" />
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" onclick={copyHtml}><CopyIcon class="size-4" /> HTML kopieren</Button>
			<!--
				Ohne Outlook bleibt der Weg ueber das Mailprogramm des Systems - den
				gab es ohnehin schon als Rueckfall, wenn Outlook nicht mitspielt.
			-->
			{#if capabilities.outlook}
				<Button onclick={sendToOutlook} disabled={sending}>
					<MailIcon class="size-4" />
					{sending ? "Öffne Outlook…" : "Outlook-Entwurf erstellen"}
				</Button>
			{:else}
				<Button onclick={prepareMail}>
					<MailIcon class="size-4" />
					E-Mail vorbereiten
				</Button>
			{/if}
		</div>
	</div>

	<Card.Root>
		<Card.Header>
			<Card.Title>Verifikation</Card.Title>
			<Card.Description>
				Gesamtsumme inkl. Abwesenheiten zum Abgleich mit dem Zeitnachweis. Gesendet wird
				ausschließlich die Tabelle aus der Vorschau – sonst nichts von dieser Seite.
			</Card.Description>
			<Card.Action>
				<Button variant="outline" onclick={() => (previewOpen = true)}>
					<EyeIcon class="size-4" /> Vorschau
				</Button>
			</Card.Action>
		</Card.Header>
		<Card.Content class="space-y-3">
			<!-- Vier Zahlen, die man gegen den Zeitnachweis haelt. Gesamt ist die Zahl,
			     um die es geht, und traegt deshalb als einzige Farbe. -->
			<div class="grid grid-cols-2 gap-3 {report.breakHours > 0 ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}">
				<StatTile label="Arbeitszeit">{fmtHoursClock(report.workHours)} h</StatTile>
				{#if report.breakHours > 0}
					<!-- Der Abzug steckt bereits in den Zahlen der Tabelle. Er gehoert
					     genannt: sonst steht im Bericht weniger als erfasst wurde, ohne
					     dass irgendwo steht, warum. -->
					<StatTile label="abzgl. Pause" hint="steckt schon in der Tabelle">
						−{fmtHoursClock(report.breakHours)} h
					</StatTile>
				{/if}
				<StatTile label="Abwesenheiten">{fmtHoursClock(report.absenceHours)} h</StatTile>
				<StatTile
					label="Gesamt"
					class="bg-primary/10 {report.breakHours > 0 ? '' : 'col-span-2 sm:col-span-1'}"
					valueClass="text-primary font-medium"
				>
					{fmtHoursClock(report.total)} h
				</StatTile>
			</div>
			{#if !app.settings.bossEmail}
				<p class="text-muted-foreground text-xs">
					Hinweis: Keine Empfänger-Adresse hinterlegt (Tab „Einstellungen“). Der Entwurf wird ohne
					Empfänger geöffnet.
				</p>
			{/if}
		</Card.Content>
	</Card.Root>

	{#if app.settings.statsEnabled}
		<StatsCard {month} {report} />
	{/if}

	{#if app.settings.arbzgEnabled}
		<ArbZgCard {month} />
	{/if}
</div>

<Dialog.Root bind:open={previewOpen}>
	<!-- sm:-Stufe noetig: dialog-content setzt selbst sm:max-w-sm, ein blankes
	     max-w-* wuerde davon ueberschrieben. Die Tabelle ist 520px breit. -->
	<Dialog.Content class="sm:max-w-3xl">
		<Dialog.Header>
			<Dialog.Title>Vorschau · {report.label}</Dialog.Title>
			<Dialog.Description>So erscheint die Tabelle in der E-Mail an deine Vorgesetzten.</Dialog.Description>
		</Dialog.Header>
		<!-- Feste helle Flaeche: die Tabelle traegt Inline-Styles fuer Outlook und
		     wuerde im Dunkelmodus sonst schwarz auf dunkel stehen. -->
		<div class="max-h-[60vh] overflow-auto rounded-md border bg-white p-4 text-black">
			<!-- Mittig ueber `mx-auto` im Block-Layout, nicht per Flex: die Tabelle ist
			     520px breit, im Scroll-Container wuerde flex+center bei wenig Platz den
			     linken Rand abschneiden. Auto-Margins fallen beim Ueberlaufen auf 0. -->
			<div class="mx-auto w-fit">
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				{@html html}
			</div>
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => fromPreview(copyHtml)}>
				<CopyIcon class="size-4" /> HTML kopieren
			</Button>
			{#if capabilities.outlook}
				<Button onclick={() => fromPreview(sendToOutlook)} disabled={sending}>
					<MailIcon class="size-4" />
					{sending ? "Öffne Outlook…" : "Outlook-Entwurf erstellen"}
				</Button>
			{:else}
				<Button onclick={() => fromPreview(prepareMail)}>
					<MailIcon class="size-4" />
					E-Mail vorbereiten
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
