<script lang="ts">
	// Bewusst kein Toast: der ist weg, bevor jemand ihn liest. Deshalb ein
	// Streifen, der stehen bleibt, bis der Passkey angelegt oder weggeklickt ist.
	import { Button } from "$lib/components/ui/button";
	import { toast } from "svelte-sonner";
	import { account } from "$lib/sync/account.svelte";
	import { isTauri } from "$lib/platform/env";
	import KeyRoundIcon from "@lucide/svelte/icons/key-round";
	import XIcon from "@lucide/svelte/icons/x";

	let withoutPasskey = $state(false);
	let asked = $state(false);
	let running = $state(false);
	let dismissed = $state(false);

	$effect(() => {
		// Nur im Browser: auf dem Rechner traegt das Geraet ein eigenes Token, und
		// einen Passkey kann es dort ohnehin nicht anlegen.
		if (isTauri() || !account.linked || asked) return;
		asked = true;
		void (async () => {
			try {
				withoutPasskey = (await account.passkeys()).length === 0;
			} catch {
				// Server nicht erreichbar - dann ist jetzt nicht der Moment dafuer.
				withoutPasskey = false;
			}
		})();
	});

	async function create() {
		running = true;
		try {
			const { prfAvailable } = await account.addPasskey("Dieser Browser");
			withoutPasskey = false;
			toast.success(
				prfAvailable
					? "Passkey angelegt. Die nächste Anmeldung ist ein Klick."
					: "Passkey angelegt. Zum Entsperren braucht dieses Gerät zusätzlich die 24 Wörter."
			);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Passkey konnte nicht angelegt werden");
		} finally {
			running = false;
		}
	}
</script>

{#if withoutPasskey && !dismissed}
	<div class="border-b border-amber-500/40 bg-amber-500/5">
		<div class="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-2 text-sm sm:px-6">
			<KeyRoundIcon class="size-4 shrink-0" />
			<p class="flex-1">
				Dieser Browser hat noch keinen Passkey. Ohne ihn brauchst du beim nächsten Mal
				wieder die Kopplung oder deine 24 Wörter.
			</p>
			<Button size="sm" disabled={running} onclick={create}>
				{running ? "Warte auf Bestätigung…" : "Passkey anlegen"}
			</Button>
			<button
				type="button"
				title="Ausblenden"
				aria-label="Ausblenden"
				class="text-muted-foreground hover:text-foreground shrink-0"
				onclick={() => (dismissed = true)}
			>
				<XIcon class="size-4" />
			</button>
		</div>
	</div>
{/if}
