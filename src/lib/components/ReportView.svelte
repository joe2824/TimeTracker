<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { buildReport, reportToHtml, reportToText } from "$lib/report";
	import { fmtHoursClock } from "$lib/time";
	import { openUrl } from "@tauri-apps/plugin-opener";
	import { createOutlookDraft, detectOutlook, explainOutlookError, mailtoFallback } from "$lib/outlook";
	import { Button } from "$lib/components/ui/button";
	import MonthSelector from "$lib/components/MonthSelector.svelte";
	import * as Card from "$lib/components/ui/card";
	import { toast } from "svelte-sonner";
	import MailIcon from "@lucide/svelte/icons/mail";
	import CopyIcon from "@lucide/svelte/icons/copy";

	let month = $state(app.currentMonth);
	let sending = $state(false);

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
			app.settings.workdays
		)
	);
	const html = $derived(reportToHtml(report));
	const subject = $derived(
		(app.settings.reportSubjectTemplate || "Stundenerfassung {month} – {name}")
			.replaceAll("{month}", report.label)
			.replaceAll("{name}", app.settings.senderName.trim())
			// leere {name}-Platzhalter und übrige Trenner aufräumen
			.replace(/\s*[–-]\s*$/, "")
			.replace(/^\s*[–-]\s*/, "")
			.replace(/\s{2,}/g, " ")
			.trim()
	);

	async function sendToOutlook() {
		sending = true;
		try {
			await createOutlookDraft(app.settings.bossEmail, subject, html);
			await app.markReportSent(month);
			toast.success("Outlook-Entwurf geöffnet. Bitte prüfen und senden.");
		} catch (e) {
			// Klar erklaeren (z.B. nur neues Outlook) und den mailto-Fallback anbieten.
			const info = await detectOutlook().catch(() => null);
			const msg = explainOutlookError(e, info);
			toast.error(msg, {
				description: "Fallback: E-Mail als Text öffnen (ohne HTML-Tabelle) oder „HTML kopieren“.",
				action: {
					label: "Mail öffnen",
					onClick: () =>
						openUrl(mailtoFallback(app.settings.bossEmail, subject, reportToText(report))).catch(
							(err) => toast.error(`Mailprogramm konnte nicht geöffnet werden: ${err}`)
						)
				}
			});
		} finally {
			sending = false;
		}
	}

	/**
	 * Legt die Tabelle als "text/html" UND "text/plain" in die Zwischenablage.
	 * Nur mit dem text/html-Flavor fuegt Outlook die gerenderte Tabelle ein –
	 * writeText() allein landet als Quelltext in der Mail.
	 */
	async function copyHtml() {
		try {
			await navigator.clipboard.write([
				new ClipboardItem({
					"text/html": new Blob([html], { type: "text/html" }),
					"text/plain": new Blob([reportToText(report)], { type: "text/plain" })
				})
			]);
			toast.success("Tabelle kopiert – in Outlook mit Strg+V einfügen.");
			return;
		} catch (e) {
			// Aeltere Webviews ohne ClipboardItem/write: Quelltext ist besser als nichts.
			try {
				await navigator.clipboard.writeText(html);
				toast.success("HTML-Quelltext kopiert.", {
					description: "Rich-Text wird von diesem System nicht unterstützt."
				});
			} catch {
				toast.error(`Kopieren fehlgeschlagen: ${e}`);
			}
		}
	}
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<MonthSelector bind:month id="rmonth" />
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" onclick={copyHtml}><CopyIcon class="size-4" /> HTML kopieren</Button>
			<Button onclick={sendToOutlook} disabled={sending}>
				<MailIcon class="size-4" />
				{sending ? "Öffne Outlook…" : "Outlook-Entwurf erstellen"}
			</Button>
		</div>
	</div>

	<Card.Root>
		<Card.Header>
			<Card.Title>Verifikation</Card.Title>
			<Card.Description>Gesamtsumme inkl. Abwesenheiten zum Abgleich mit dem Zeitnachweis.</Card.Description>
		</Card.Header>
		<Card.Content>
			<div class="flex flex-wrap gap-6 text-sm">
				<div>Arbeitszeit: <strong>{fmtHoursClock(report.workHours)} h</strong></div>
				<div>Abwesenheiten: <strong>{fmtHoursClock(report.absenceHours)} h</strong></div>
				<div>Gesamt: <strong>{fmtHoursClock(report.total)} h</strong></div>
			</div>
			{#if !app.settings.bossEmail}
				<p class="text-muted-foreground mt-2 text-xs">
					Hinweis: Keine Chef-E-Mail hinterlegt (Tab „Einstellungen“). Der Entwurf wird ohne
					Empfänger geöffnet.
				</p>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Vorschau</Card.Title>
			<Card.Description>So erscheint die Tabelle in der E-Mail an deinen Chef.</Card.Description>
		</Card.Header>
		<Card.Content>
			<div class="overflow-x-auto rounded-md border bg-white p-4 text-black">
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				{@html html}
			</div>
		</Card.Content>
	</Card.Root>
</div>
