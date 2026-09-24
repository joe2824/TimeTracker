<script lang="ts">
	// Der Dialog, der aufgeht, wenn ein Team-Beitritts-Link ankommt.
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
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
		} else {
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
					Aktivität.
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		{#if flow.preview !== "loading" && flow.preview !== "error"}
			<p class="bg-muted rounded-md px-3 py-2 text-sm">
				Adresse: <span class="font-medium">{serverHost}</span> – stimmt sie nicht mit der überein, die
				dein Chef genannt hat, lieber abbrechen.
			</p>
			<div class="space-y-2">
				<Label for="team-join-name">Dein Name</Label>
				<Input
					id="team-join-name"
					bind:value={flow.name}
					placeholder="Anna Meier"
					disabled={flow.busy}
					onkeydown={(e) => e.key === "Enter" && flow.canJoin && join()}
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
					onkeydown={(e) => e.key === "Enter" && flow.canJoin && join()}
				/>
				{#if flow.emailInvalid}
					<p class="text-destructive text-xs">Das ist keine gültige E-Mail-Adresse.</p>
				{:else}
					<p class="text-muted-foreground text-xs">
						Nur damit der Chef dich erinnern kann, falls ein Bericht fehlt.
					</p>
				{/if}
			</div>
			{#if flow.existing}
				<p class="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
					Du bist bereits im Team „{flow.existing.teamName}“. Mit dem Beitritt verlässt du es – deine
					erfassten Zeiten bleiben erhalten.
				</p>
			{/if}
		{/if}

		<Dialog.Footer>
			<Button variant="outline" disabled={flow.busy} onclick={dismiss}>Abbrechen</Button>
			{#if flow.preview !== "loading" && flow.preview !== "error"}
				<Button disabled={!flow.canJoin} onclick={join}>
					{flow.busy ? "Wird verbunden…" : "Beitreten"}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
