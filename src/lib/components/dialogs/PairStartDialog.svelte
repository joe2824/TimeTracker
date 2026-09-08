<script lang="ts">
	// Der Browser hat diese Anwendung gebeten, eine Kopplung zu beginnen
	// (`timetracker://pair?server=...`). Sie holt den Code und zeigt ihn gross -
	// eingetragen wird er drueben, wo das Konto schon haengt.
	//
	// Der Code reist bewusst NICHT im Link zurueck. Er ist der Abdruck des
	// Geraeteschluessels, den der Browser gleich mit dem Vault-Schluessel
	// versorgt; ihn selbst zu uebertragen ist die Pruefung, dass dort wirklich
	// dieses Geraet ankommt und kein untergeschobenes.
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import PairingCode from "$lib/components/onboarding/PairingCode.svelte";
	import { account } from "$lib/sync/account.svelte";
	import { PairingFlow } from "$lib/account/pairingFlow.svelte";
	import { errorText } from "$lib/log";
	import { toast } from "svelte-sonner";

	let busy = $state(false);
	let failed = $state("");

	const pairing = new PairingFlow({
		done: () => {
			account.pairStartRequest = "";
			toast.success("Dieses Gerät ist jetzt verknüpft.");
		},
		failed: (e) => {
			failed = errorText(e);
		}
	});

	const open = $derived(!!account.pairStartRequest);
	/**
	 * Diese Anwendung haengt schon an einem Konto.
	 *
	 * `startPairing` fragt das nicht - es legt einfach ein neues Schluesselpaar an.
	 * Wird das drueben bestaetigt, ist es ein Kontowechsel: im Browser faellt der
	 * lokale Bestand weg, auf dem Rechner bleibt er liegen, geht aber nicht mehr
	 * hoch. Deshalb erst fragen.
	 */
	const alreadyLinked = $derived(account.linked);
	/** Gleiche Adresse: dann ist es sehr wahrscheinlich dasselbe Konto. */
	const sameServer = $derived(
		!!account.serverUrl &&
			account.serverUrl.replace(/\/+$/, "") === account.pairStartRequest.replace(/\/+$/, "")
	);
	let confirmed = $state(false);

	function dismiss() {
		account.pairStartRequest = "";
		failed = "";
		confirmed = false;
		pairing.cancel();
	}

	// Sobald die Bitte ankommt: Code holen. `pairing` sieht danach selbst nach,
	// ob drueben bestaetigt wurde, und schliesst den Dialog ueber `open`.
	$effect(() => {
		const server = account.pairStartRequest;
		if (!server || pairing.code || busy) return;
		if (alreadyLinked && !confirmed) return;
		busy = true;
		failed = "";
		void pairing
			.start(server)
			.catch((e: unknown) => {
				failed = errorText(e);
			})
			.finally(() => {
				busy = false;
			});
	});
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
				{alreadyLinked && !confirmed ? "Diese Anwendung ist schon verknüpft" : "Dieses Gerät verbinden"}
			</Dialog.Title>
			<Dialog.Description>
				{#if alreadyLinked && !confirmed}
					{#if sameServer}
						Sie hängt bereits an einem Konto auf diesem Server – wahrscheinlich ist es
						dasselbe, dann musst du nichts tun.
					{:else}
						Sie hängt an einem Konto auf {account.serverUrl}. Eine neue Kopplung ersetzt das.
					{/if}
				{:else if failed}
					Die Kopplung konnte nicht beginnen.
				{:else if pairing.code}
					Gib diesen Code im Browser ein, dort wartet er schon. Danach sind deine Zeiten auch
					hier.
				{:else}
					Code wird geholt…
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		{#if alreadyLinked && !confirmed}
			<p class="text-muted-foreground text-sm">
				Koppelst du mit einem <strong>anderen</strong> Konto, verliert dieses Gerät die
				Verbindung zum bisherigen – im Browser samt der Zeiten, die hier liegen.
			</p>
		{:else if failed}
			<p class="text-destructive text-sm">{failed}</p>
		{:else if pairing.code}
			<PairingCode code={pairing.code} />
		{/if}

		<Dialog.Footer>
			<Button variant="outline" disabled={busy} onclick={dismiss}>
				{alreadyLinked && !confirmed ? "Nichts ändern" : pairing.code ? "Abbrechen" : "Schliessen"}
			</Button>
			{#if alreadyLinked && !confirmed}
				<Button variant="destructive" onclick={() => (confirmed = true)}>Trotzdem koppeln</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
