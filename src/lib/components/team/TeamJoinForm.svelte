<script lang="ts">
	// Name, E-Mail und Hinweis auf eine bestehende Mitgliedschaft - gemeinsam für
	// den Desktop-Dialog (JoinTeamDialog) und die Web-Route (routes/team/join).
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import type { TeamJoinFlow } from "$lib/team/joinFlow.svelte";

	interface Props {
		flow: TeamJoinFlow;
		serverUrl: string;
		/** Nur der Dialog nennt die Adresse: dort bestimmt der Link den Server frei. */
		serverHost?: string;
		onjoin: () => void;
	}
	let { flow, serverUrl, serverHost, onjoin }: Props = $props();

	const sameTeam = $derived(flow.sameTeam(serverUrl));

	function onkeydown(e: KeyboardEvent) {
		if (e.key === "Enter" && flow.canJoinAt(serverUrl)) onjoin();
	}
</script>

{#if serverHost}
	<p class="bg-muted rounded-md px-3 py-2 text-sm">
		Adresse: <span class="font-medium">{serverHost}</span> – stimmt sie nicht mit der überein, die
		dir dein Vorgesetzter oder deine Vorgesetzte genannt hat, lieber abbrechen.
	</p>
{/if}
<div class="space-y-2">
	<Label for="team-join-name">Dein Name</Label>
	<Input
		id="team-join-name"
		bind:value={flow.name}
		placeholder="Anna Meier"
		disabled={flow.busy}
		{onkeydown}
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
		{onkeydown}
	/>
	{#if flow.emailInvalid}
		<p class="text-destructive text-xs">Das ist keine gültige E-Mail-Adresse.</p>
	{:else}
		<p class="text-muted-foreground text-xs">
			Nur damit dich der oder die Vorgesetzte erinnern kann, falls ein Bericht fehlt.
		</p>
	{/if}
</div>
{#if flow.existing && sameTeam}
	<p class="rounded-md border px-3 py-2 text-sm">
		Du bist schon in diesem Team – hier ist nichts weiter zu tun.
	</p>
{:else if flow.existing}
	<p class="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
		Du bist bereits im Team „{flow.existing.teamName}“. Mit dem Beitritt verlässt du es – deine
		erfassten Zeiten bleiben erhalten.
	</p>
{/if}
