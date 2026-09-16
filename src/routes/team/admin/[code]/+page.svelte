<script lang="ts">
	// Verwalter-Link annehmen - anders als der einfache Mitglieds-Beitritt
	// (routes/team/join/[code]) braucht das ein angemeldetes Konto auf diesem
	// Server, siehe server/src/lib/server/teams.ts#joinTeamAsAdmin.
	import { page } from "$app/state";
	import { account } from "$lib/sync/account.svelte";
	import { previewAdminInvite } from "$lib/team/api";
	import { Button } from "$lib/components/ui/button";
	import { errorText } from "$lib/log";

	const code = $derived(page.params.code ?? "");
	const serverUrl = $derived(page.url.origin);

	let preview = $state<{ teamName: string } | "loading" | "error">("loading");
	let joinedTeamName = $state<string | null>(null);
	let joinError = $state<string | null>(null);
	let busy = $state(false);

	$effect(() => {
		if (!code) return;
		preview = "loading";
		previewAdminInvite(serverUrl, code)
			.then((p) => (preview = p))
			.catch(() => (preview = "error"));
	});

	async function accept() {
		busy = true;
		joinError = null;
		try {
			const team = await account.joinTeamAsAdmin(code);
			joinedTeamName = team.name;
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
			<h1 class="text-xl font-semibold">Verwalter von „{joinedTeamName}"</h1>
			<p class="text-muted-foreground text-sm">
				Das Team erscheint jetzt in deinen Einstellungen unter „Team" - dort auch Mitglieder,
				Aktivitäten und Berichte.
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
	{:else if !account.linked}
		<div class="w-full space-y-4 text-center">
			<div class="space-y-2">
				<h1 class="text-xl font-semibold">Als Verwalter von „{preview.teamName}" helfen?</h1>
				<p class="text-muted-foreground text-sm">
					Dafür brauchst du ein Konto auf diesem Server - anders als ein einfaches Teammitglied.
					Melde dich an oder lege eins an, und öffne diesen Link danach erneut.
				</p>
			</div>
			<Button class="w-full" href="/">Anmelden oder Konto anlegen</Button>
		</div>
	{:else}
		<div class="w-full space-y-4">
			<div class="space-y-2 text-center">
				<h1 class="text-xl font-semibold">Als Verwalter von „{preview.teamName}" helfen?</h1>
				<p class="text-muted-foreground text-sm">
					Du bist angemeldet als <span class="text-foreground font-medium">{account.name}</span>.
					Als Verwalter kannst du Aktivitäten pflegen, Mitglieder sehen und Berichte prüfen - so wie
					der Chef, nur das Team nicht löschen oder weitere Verwalter einsetzen.
				</p>
			</div>

			{#if joinError}
				<p class="text-destructive text-sm">Annehmen nicht möglich: {joinError}</p>
			{/if}

			<Button class="w-full" disabled={busy} onclick={accept}>
				{busy ? "Wird angenommen…" : "Annehmen"}
			</Button>
		</div>
	{/if}
</div>
