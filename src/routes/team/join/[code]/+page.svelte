<script lang="ts">
	// Die Seite, die ein Team-Einladungslink im Browser öffnet - unabhängig von
	// der Desktop-Anwendung: ein Team-Mitglied braucht kein Konto und keine
	// Installation. Wer die Anwendung schon hat, bekommt zusätzlich den Weg
	// dorthin (siehe PairingCode.svelte für dasselbe Muster bei der Kopplung).
	import { page } from "$app/state";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { previewTeam, completeTeamJoin } from "$lib/team/join";
	import { teamJoinLink } from "$lib/platform/deeplink";
	import { isTauri } from "$lib/platform/env";
	import { errorText } from "$lib/log";
	import ExternalLinkIcon from "@lucide/svelte/icons/external-link";

	const code = $derived(page.params.code ?? "");
	const serverUrl = $derived(page.url.origin);

	let name = $state("");
	let email = $state("");
	let busy = $state(false);
	let preview = $state<{ teamName: string } | "loading" | "error">("loading");
	let joinedTeamName = $state<string | null>(null);
	let joinError = $state<string | null>(null);

	$effect(() => {
		if (!code) return;
		preview = "loading";
		previewTeam(serverUrl, code)
			.then((p) => (preview = p))
			.catch(() => (preview = "error"));
	});

	async function join() {
		busy = true;
		joinError = null;
		try {
			const info = await completeTeamJoin(serverUrl, code, name.trim(), email.trim());
			joinedTeamName = info.teamName;
		} catch (e) {
			joinError = errorText(e);
		} finally {
			busy = false;
		}
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
	{:else if preview === "loading"}
		<p class="text-muted-foreground text-sm">Link wird geprüft…</p>
	{:else if preview === "error"}
		<div class="space-y-2 text-center">
			<h1 class="text-xl font-semibold">Link nicht gültig</h1>
			<p class="text-muted-foreground text-sm">
				Dieser Link ist abgelaufen oder wurde zurückgezogen - beim Chef nach einem neuen fragen.
			</p>
		</div>
	{:else}
		<div class="w-full space-y-4">
			<div class="space-y-2 text-center">
				<h1 class="text-xl font-semibold">Mit „{preview.teamName}" verbinden?</h1>
				<p class="text-muted-foreground text-sm">
					Die gemeinsamen Aktivitäten dieses Teams werden auf diesem Gerät verfügbar, und der Chef
					sieht, wann von hier ein Bericht gesendet wurde.
				</p>
			</div>

			<div class="space-y-2">
				<Label for="team-join-name">Dein Name</Label>
				<Input
					id="team-join-name"
					bind:value={name}
					placeholder="Anna Meier"
					disabled={busy}
					onkeydown={(e) => e.key === "Enter" && name.trim() && join()}
				/>
			</div>
			<div class="space-y-2">
				<Label for="team-join-email">E-Mail (optional)</Label>
				<Input
					id="team-join-email"
					type="email"
					bind:value={email}
					placeholder="anna@firma.de"
					disabled={busy}
					onkeydown={(e) => e.key === "Enter" && name.trim() && join()}
				/>
				<p class="text-muted-foreground text-xs">
					Nur damit der Chef dich erinnern kann, falls ein Bericht fehlt.
				</p>
			</div>

			{#if joinError}
				<p class="text-destructive text-sm">Beitritt nicht möglich: {joinError}</p>
			{/if}

			<Button class="w-full" disabled={busy || !name.trim()} onclick={join}>
				{busy ? "Wird verbunden…" : "Beitreten"}
			</Button>

			{#if !isTauri()}
				<Button variant="outline" class="w-full" href={teamJoinLink(serverUrl, code)}>
					<ExternalLinkIcon class="size-4" /> In der App öffnen
				</Button>
			{/if}
		</div>
	{/if}
</div>
