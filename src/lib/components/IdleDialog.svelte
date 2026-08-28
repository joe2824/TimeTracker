<script lang="ts">
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { app } from "$lib/app.svelte";
	import { fmtClock, fmtHMS } from "$lib/time";
	import { watchers, resolveIdle } from "$lib/watchers.svelte";

	const p = $derived(watchers.idlePrompt);
	const open = $derived(!!p);
</script>

<Dialog.Root
	{open}
	onOpenChange={(v) => {
		if (!v) void resolveIdle("keep");
	}}
>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Weg gewesen?</Dialog.Title>
			<Dialog.Description>
				{#if p}
					Seit <strong>{fmtHMS(p.idleSeconds)}</strong> keine Eingabe (ab ca.
					{fmtClock(p.idleStart)}).
					{#if app.running}
						Timer „{app.activityName(app.running.activityId)}" läuft weiter.
					{/if}
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="ghost" onclick={() => resolveIdle("discard")}>Eintrag verwerfen</Button>
			<Button variant="outline" onclick={() => resolveIdle("subtract")}>Leerlauf abziehen</Button>
			<Button onclick={() => resolveIdle("keep")}>Zeit behalten</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
