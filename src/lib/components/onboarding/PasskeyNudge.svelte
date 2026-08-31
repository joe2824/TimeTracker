<script lang="ts">
	// Bewusst kein Toast: der ist weg, bevor jemand ihn liest. Deshalb ein
	// Streifen, der stehen bleibt, bis der Passkey sitzt oder weggeklickt ist.
	import { Button } from "$lib/components/ui/button";
	import { toast } from "svelte-sonner";
	import { account } from "$lib/sync/account.svelte";
	import { isTauri } from "$lib/platform/env";
	import KeyRoundIcon from "@lucide/svelte/icons/key-round";
	import XIcon from "@lucide/svelte/icons/x";

	/** Was diesem Browser zum reibungslosen Anmelden fehlt. */
	type Missing = "passkey" | "wrap" | null;

	let missing = $state<Missing>(null);
	let gefragt = $state(false);
	let laeuft = $state(false);
	let weggeklickt = $state(false);

	const texts = {
		passkey: {
			text: "Dieser Browser hat noch keinen Passkey. Ohne ihn brauchst du beim nächsten Mal wieder die Kopplung oder deine 24 Wörter.",
			button: "Passkey anlegen"
		},
		wrap: {
			text: "Dein Passkey meldet dich an, entsperrt deine Daten aber noch nicht. Einmal bestätigen – danach brauchst du die 24 Wörter beim Anmelden nicht mehr.",
			button: "Jetzt verbinden"
		}
	};

	$effect(() => {
		// Nur im Browser: auf dem Rechner traegt das Geraet ein eigenes Token, und
		// einen Passkey kann es dort ohnehin nicht anlegen.
		if (isTauri() || !account.linked || gefragt) return;
		gefragt = true;
		void check().catch(() => (missing = null));
	});

	async function check() {
		const passkeys = await account.passkeys();
		if (passkeys.length === 0) missing = "passkey";
		// Kontoweit, nicht je Passkey: welcher an DIESEM Browser haengt, ist von
		// hier aus nicht zu sehen.
		else missing = passkeys.every((p) => !p.hasWrap) ? "wrap" : null;
	}

	async function resolve() {
		laeuft = true;
		try {
			const done =
				missing === "passkey"
					? (await account.addPasskey("Dieser Browser")).prfAvailable
					: await account.repairPasskeyWrap();
			await check();
			if (done) {
				toast.success("Erledigt. Dein Passkey entsperrt deine Daten jetzt allein.");
			} else {
				// Der Authentifikator kann kein PRF - ein zweiter Versuch aendert daran nichts.
				weggeklickt = true;
				toast.error("Dieses Gerät kann deine Daten mit dem Passkey allein nicht entsperren.");
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Hat nicht geklappt");
		} finally {
			laeuft = false;
		}
	}
</script>

{#if missing && !weggeklickt}
	<div class="border-b border-amber-500/40 bg-amber-500/5">
		<div class="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-2 text-sm sm:px-6">
			<KeyRoundIcon class="size-4 shrink-0" />
			<p class="flex-1">{texts[missing].text}</p>
			<Button size="sm" disabled={laeuft} onclick={resolve}>
				{laeuft ? "Warte auf Bestätigung…" : texts[missing].button}
			</Button>
			<button
				type="button"
				title="Ausblenden"
				aria-label="Ausblenden"
				class="text-muted-foreground hover:text-foreground shrink-0"
				onclick={() => (weggeklickt = true)}
			>
				<XIcon class="size-4" />
			</button>
		</div>
	</div>
{/if}
