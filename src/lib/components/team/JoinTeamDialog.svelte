<script lang="ts">
	// Der Dialog, der aufgeht, wenn ein Team-Beitritts-Link ankommt.
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import TeamJoinForm from "./TeamJoinForm.svelte";
	import { teamJoin } from "$lib/team/state.svelte";
	import { TeamJoinFlow } from "$lib/team/joinFlow.svelte";
	import { normalizeServerUrl } from "$lib/sync/api";
	import { toast } from "svelte-sonner";

	const flow = new TeamJoinFlow();

	const open = $derived(teamJoin.pendingLink !== null);
	// Der Link bestimmt den Server frei - ohne diese Anzeige sähe der Nutzer nie,
	// wohin Name/E-Mail beim Beitreten tatsächlich gehen (auch ein untergeschobener
	// Link zeigt ja einen Teamnamen an, den holt er sich vom selben fremden Server).
	const serverHost = $derived.by(() => {
		const link = teamJoin.pendingLink;
		if (!link) return "";
		try {
			return new URL(normalizeServerUrl(link.serverUrl)).host;
		} catch {
			return link.serverUrl;
		}
	});

	$effect(() => {
		const link = teamJoin.pendingLink;
		if (!link) return;
		void flow.loadPreview(link.serverUrl, link.code);
	});

	function dismiss() {
		teamJoin.pendingLink = null;
		flow.reset();
	}

	async function join() {
		const link = teamJoin.pendingLink;
		if (!link) return;
		const info = await flow.join(link.serverUrl, link.code);
		if (info) {
			dismiss();
			toast.success(`Mit „${info.teamName}“ verbunden.`);
		} else if (flow.joinError) {
			toast.error(`Beitritt nicht möglich: ${flow.joinError}`);
		}
	}
</script>

<Dialog.Root
	{open}
	onOpenChange={(o) => {
		if (!o && !flow.busy) dismiss();
	}}
>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>
				{#if flow.preview === "loading"}
					Team-Link wird geprüft…
				{:else if flow.preview === "error"}
					Link nicht gültig
				{:else}
					Mit „{flow.preview.teamName}“ verbinden?
				{/if}
			</Dialog.Title>
			<Dialog.Description>
				{#if flow.preview === "error"}
					Dieser Link ist abgelaufen oder wurde zurückgezogen – frag deinen Chef nach einem neuen.
				{:else}
					Die gemeinsamen Aktivitäten dieses Teams werden auf diesem Gerät verfügbar. Wenn du deinen
					Monatsbericht sendest, bekommen Chef und Verwalter des Teams eine Kopie mit deinen Stunden je
					Aktivität – auch der Aktivitäten, die nur du angelegt hast.
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		{#if teamJoin.pendingLink && flow.preview !== "loading" && flow.preview !== "error"}
			<TeamJoinForm {flow} serverUrl={teamJoin.pendingLink.serverUrl} {serverHost} onjoin={join} />
		{/if}

		<Dialog.Footer>
			<Button variant="outline" disabled={flow.busy} onclick={dismiss}>Abbrechen</Button>
			{#if flow.preview !== "loading" && flow.preview !== "error"}
				<Button
					disabled={!teamJoin.pendingLink || !flow.canJoinAt(teamJoin.pendingLink.serverUrl)}
					onclick={join}
				>
					{flow.busy ? "Wird verbunden…" : "Beitreten"}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
