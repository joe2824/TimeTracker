<script lang="ts">
	import { onMount } from "svelte";
	import { app } from "$lib/app.svelte";
	import { listEntryMonths } from "$lib/store";
	import { buildReport, reportToHtml } from "$lib/report";
	import { fmtHoursClock, monthLabel } from "$lib/time";
	import { createOutlookDraft } from "$lib/outlook";
	import { Button } from "$lib/components/ui/button";
	import { Label } from "$lib/components/ui/label";
	import * as Card from "$lib/components/ui/card";
	import { toast } from "svelte-sonner";
	import MailIcon from "@lucide/svelte/icons/mail";
	import CopyIcon from "@lucide/svelte/icons/copy";

	let month = $state(app.currentMonth);
	let months = $state<string[]>([]);
	let sending = $state(false);

	async function refreshMonths() {
		const stored = await listEntryMonths();
		months = [...new Set([app.currentMonth, month, ...stored])].sort().reverse();
	}
	onMount(refreshMonths);
	$effect(() => {
		void app.ensureMonth(month);
	});

	const report = $derived(
		buildReport(
			month,
			app.activities,
			app.monthEntries(month),
			app.settings.rounding,
			app.settings.hoursPerDay
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
			toast.error(`Outlook-Entwurf fehlgeschlagen: ${e}. Tipp: „HTML kopieren“ und manuell einfügen.`);
		} finally {
			sending = false;
		}
	}

	async function copyHtml() {
		try {
			await navigator.clipboard.writeText(html);
			toast.success("HTML-Tabelle in die Zwischenablage kopiert.");
		} catch (e) {
			toast.error(`Kopieren fehlgeschlagen: ${e}`);
		}
	}
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div class="space-y-1">
			<Label for="rmonth">Monat</Label>
			<select
				id="rmonth"
				bind:value={month}
				class="border-input bg-background h-9 rounded-md border px-3 text-sm"
			>
				{#each months as m (m)}
					<option value={m}>{monthLabel(m)}</option>
				{/each}
			</select>
		</div>
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
