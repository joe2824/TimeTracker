<script lang="ts">
	// Die Seite, die ein Team-Einladungslink im Browser öffnet - unabhängig von
	// der Desktop-Anwendung: ein Team-Mitglied braucht kein Konto und keine
	// Installation. Wer die Anwendung schon hat, bekommt zusätzlich den Weg
	// dorthin (siehe PairingCode.svelte für dasselbe Muster bei der Kopplung).
	import { onDestroy } from "svelte";
	import { page } from "$app/state";
	import { app } from "$lib/app.svelte";
	import { Button } from "$lib/components/ui/button";
	import { TeamJoinFlow } from "$lib/team/joinFlow.svelte";
	import TeamJoinForm from "$lib/components/team/TeamJoinForm.svelte";
	import { teamJoinLink } from "$lib/platform/deeplink";
	import { isTauri } from "$lib/platform/env";
	import ExternalLinkIcon from "@lucide/svelte/icons/external-link";

	const code = $derived(page.params.code ?? "");
	const serverUrl = $derived(page.url.origin);

	const flow = new TeamJoinFlow();
	// Der Beitritt startet die App (siehe completeTeamJoin) - deren Uhr soll nicht
	// über die Route hinaus laufen.
	onDestroy(() => app.dispose());
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
			<h1 class="text-xl font-semibold">Mit „{joinedTeamName}“ verbunden</h1>
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
				Dieser Link ist abgelaufen oder wurde zurückgezogen – frag deinen Chef nach einem neuen.
			</p>
		</div>
	{:else}
		<div class="w-full space-y-4">
			<div class="space-y-2 text-center">
				<h1 class="text-xl font-semibold">Mit „{flow.preview.teamName}“ verbinden?</h1>
				<p class="text-muted-foreground text-sm">
					Die gemeinsamen Aktivitäten dieses Teams werden auf diesem Gerät verfügbar. Wenn du deinen
					Monatsbericht sendest, bekommen Chef und Verwalter des Teams eine Kopie mit deinen Stunden je
					Aktivität – auch der Aktivitäten, die nur du angelegt hast.
				</p>
			</div>

			<TeamJoinForm {flow} {serverUrl} onjoin={join} />

			{#if flow.joinError}
				<p class="text-destructive text-sm">Beitritt nicht möglich: {flow.joinError}</p>
			{/if}

			<Button class="w-full" disabled={!flow.canJoinAt(serverUrl)} onclick={join}>
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
