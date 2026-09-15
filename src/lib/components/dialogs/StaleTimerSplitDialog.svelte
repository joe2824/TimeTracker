<script lang="ts">
	// Ein Timer lief über Mitternacht, während das Gerät offline war, und wurde
	// dabei automatisch in Tagesstücke geteilt. Hat ein anderes Gerät denselben
	// Lauf inzwischen früher beendet, weiss der Abgleich nicht, ob danach echt
	// weitergearbeitet wurde oder nicht - das kann nur ein Mensch entscheiden.
	// Deshalb bleiben beide Einträge stehen, und hier kommt der Hinweis, danach
	// zu sehen.
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { account } from "$lib/sync/account.svelte";

	let seen = $state(false);

	const open = $derived(account.staleTimerSplits > 0 && !seen);

	function dismiss() {
		seen = true;
		account.staleTimerSplits = 0;
	}
</script>

<Dialog.Root
	{open}
	onOpenChange={(o) => {
		if (!o) dismiss();
	}}
>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Bitte einen Tag prüfen</Dialog.Title>
			<Dialog.Description>
				Ein Timer lief über Mitternacht, während dieses Gerät keine Verbindung zum Server hatte.
				Auf einem anderen Gerät wurde er in der Zwischenzeit schon früher beendet. Beide Einträge
				wurden behalten, damit nichts verloren geht – bitte im Zeiten-Bereich nachsehen, welcher
				davon stimmt.
			</Dialog.Description>
		</Dialog.Header>

		<Dialog.Footer>
			<Button onclick={dismiss}>Alles gut</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
