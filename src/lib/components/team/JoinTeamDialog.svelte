<script lang="ts">
	// Der Dialog, der aufgeht, wenn ein Team-Beitritts-Link ankommt. Anders als
	// bei der Konto-Kopplung ist hier kein Vergleich mit einem vorhandenen
	// Zustand nötig - ein Team-Mitglied hat kein Konto und keinen laufenden
	// Vorgang, gegen den sich der Link fälschen liesse.
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { teamJoin } from "$lib/team/state.svelte";
	import { completeTeamJoin, previewTeam } from "$lib/team/join";
	import { errorText } from "$lib/log";
	import { toast } from "svelte-sonner";

	let name = $state("");
	let busy = $state(false);
	let preview = $state<{ teamName: string } | "loading" | "error">("loading");

	const open = $derived(teamJoin.pendingLink !== null);

	$effect(() => {
		const link = teamJoin.pendingLink;
		if (!link) return;
		preview = "loading";
		previewTeam(link.serverUrl, link.code)
			.then((p) => (preview = p))
			.catch(() => (preview = "error"));
	});

	function dismiss() {
		teamJoin.pendingLink = null;
		name = "";
	}

	async function join() {
		const link = teamJoin.pendingLink;
		if (!link) return;
		busy = true;
		try {
			const info = await completeTeamJoin(link.serverUrl, link.code, name.trim());
			dismiss();
			toast.success(`Mit „${info.teamName}" verbunden.`);
		} catch (e) {
			toast.error(`Beitritt nicht möglich: ${errorText(e)}`);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root
	{open}
	onOpenChange={(o) => {
		if (!o && !busy) dismiss();
	}}
>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>
				{#if preview === "loading"}
					Team-Link wird geprüft…
				{:else if preview === "error"}
					Link nicht gültig
				{:else}
					Mit „{preview.teamName}" verbinden?
				{/if}
			</Dialog.Title>
			<Dialog.Description>
				{#if preview === "error"}
					Dieser Link ist abgelaufen oder wurde zurückgezogen - beim Chef nach einem neuen fragen.
				{:else}
					Die gemeinsamen Aktivitäten dieses Teams werden auf diesem Gerät verfügbar, und der Chef
					sieht, wann von hier ein Bericht gesendet wurde.
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		{#if preview !== "loading" && preview !== "error"}
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
		{/if}

		<Dialog.Footer>
			<Button variant="outline" disabled={busy} onclick={dismiss}>Abbrechen</Button>
			{#if preview !== "loading" && preview !== "error"}
				<Button disabled={busy || !name.trim()} onclick={join}>
					{busy ? "Wird verbunden…" : "Beitreten"}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
