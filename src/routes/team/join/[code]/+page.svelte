<script lang="ts">
	// Die Seite, die ein Team-Einladungslink im Browser öffnet - unabhängig von
	// der Desktop-Anwendung: ein Team-Mitglied braucht kein Konto und keine
	// Installation. Wer die Anwendung schon hat, bekommt zusätzlich den Weg
	// dorthin (siehe PairingCode.svelte für dasselbe Muster bei der Kopplung).
	import { page } from "$app/state";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { TeamJoinFlow } from "$lib/team/joinFlow.svelte";
	import { teamJoinLink } from "$lib/platform/deeplink";
	import { isTauri } from "$lib/platform/env";
	import ExternalLinkIcon from "@lucide/svelte/icons/external-link";

	const code = $derived(page.params.code ?? "");
	const serverUrl = $derived(page.url.origin);

	const flow = new TeamJoinFlow();
	let joinedTeamName = $state<string | null>(null);

	$effect(() => {
		if (!code) return;
		void flow.loadPreview(serverUrl, code);
	});

	async function join() {
		const info = await flow.join(serverUrl, code);
		if (info) joinedTeamName = info.teamName;
	}
</script>

<div class="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-6 p-6">
	{#if joinedTeamName}
		<div class="space-y-2 text-center">
			<h1 class="text-xl font-semibold">Mit „{joinedTeamName}" verbunden</h1>
			<p class="text-muted-foreground text-sm">
				Die gemeinsamen Aktivitäten dieses Teams sind jetzt hier verfügbar.
			</p>
		</div>
	{:else if flow.preview === "loading"}
		<p class="text-muted-foreground text-sm">Link wird geprüft…</p>
	{:else if flow.preview === "error"}
		<div class="space-y-2 text-center">
			<h1 class="text-xl font-semibold">Link nicht gültig</h1>
			<p class="text-muted-foreground text-sm">
				Dieser Link ist abgelaufen oder wurde zurückgezogen - beim Chef nach einem neuen fragen.
			</p>
		</div>
	{:else}
		<div class="w-full space-y-4">
			<div class="space-y-2 text-center">
				<h1 class="text-xl font-semibold">Mit „{flow.preview.teamName}" verbinden?</h1>
				<p class="text-muted-foreground text-sm">
					Die gemeinsamen Aktivitäten dieses Teams werden auf diesem Gerät verfügbar, und der Chef
					sieht, wann von hier ein Bericht gesendet wurde.
				</p>
			</div>

			<div class="space-y-2">
				<Label for="team-join-name">Dein Name</Label>
				<Input
					id="team-join-name"
					bind:value={flow.name}
					placeholder="Anna Meier"
					disabled={flow.busy}
					onkeydown={(e) => e.key === "Enter" && flow.name.trim() && join()}
				/>
			</div>
			<div class="space-y-2">
				<Label for="team-join-email">E-Mail (optional)</Label>
				<Input
					id="team-join-email"
					type="email"
					bind:value={flow.email}
					placeholder="anna@firma.de"
					disabled={flow.busy}
					onkeydown={(e) => e.key === "Enter" && flow.name.trim() && join()}
				/>
				<p class="text-muted-foreground text-xs">
					Nur damit der Chef dich erinnern kann, falls ein Bericht fehlt.
				</p>
			</div>

			{#if flow.joinError}
				<p class="text-destructive text-sm">Beitritt nicht möglich: {flow.joinError}</p>
			{/if}

			<Button class="w-full" disabled={flow.busy || !flow.name.trim()} onclick={join}>
				{flow.busy ? "Wird verbunden…" : "Beitreten"}
			</Button>

			{#if !isTauri()}
				<Button variant="outline" class="w-full" href={teamJoinLink(serverUrl, code)}>
					<ExternalLinkIcon class="size-4" /> In der App öffnen
				</Button>
			{/if}
		</div>
	{/if}
</div>
