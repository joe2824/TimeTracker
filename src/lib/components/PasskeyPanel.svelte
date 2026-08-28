<script lang="ts">
	import * as Card from "$lib/components/ui/card";
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { toast } from "svelte-sonner";
	import { account } from "$lib/sync/account.svelte";
	import type { Passkey } from "$lib/sync/api";
	import { fmtDateHuman } from "$lib/time";
	import { isTauri } from "$lib/platform/env";
	import { openExternal } from "$lib/platform/open";

	let liste = $state<Passkey[]>([]);
	let geladen = $state(false);
	let laeuft = $state(false);
	let name = $state("");
	/** Welchen benennt man gerade um? */
	let benennt = $state<string | null>(null);
	let neuerName = $state("");

	async function laden() {
		try {
			liste = await account.passkeys();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Passkeys nicht abrufbar");
		} finally {
			geladen = true;
		}
	}

	$effect(() => {
		if (account.linked && !geladen) void laden();
	});

	async function hinzufuegen() {
		laeuft = true;
		try {
			const { prfAvailable } = await account.addPasskey(name.trim() || "Weiterer Passkey");
			name = "";
			await laden();
			if (prfAvailable) {
				toast.success("Passkey hinzugefügt. Er öffnet die Daten allein.");
			} else {
				// Ehrlich sein: er meldet an, aber der Tresor braucht dann noch die
				// Phrase oder ein entsperrtes Gerät. Wer das nicht weiss, glaubt sich
				// abgesichert und ist es nicht.
				toast.success(
					"Passkey hinzugefügt. Dieses Gerät kann die Daten nicht allein entsperren – " +
						"dafür braucht es zusätzlich die Wiederherstellungs-Phrase."
				);
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Hinzufügen fehlgeschlagen");
		} finally {
			laeuft = false;
		}
	}

	/** Welcher soll weg? Gesetzt heisst: die Rueckfrage steht offen. */
	let entfernt = $state<Passkey | null>(null);

	async function entfernenBestaetigt() {
		const p = entfernt;
		if (!p) return;
		try {
			await account.removePasskey(p.id);
			entfernt = null;
			await laden();
			toast.success("Passkey entfernt.");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Entfernen fehlgeschlagen");
		}
	}

	async function umbenennen(id: string) {
		try {
			await account.renamePasskey(id, neuerName.trim());
			benennt = null;
			await laden();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Umbenennen fehlgeschlagen");
		}
	}

	/** Wie viele koennen den Tresor allein oeffnen? Daran haengt die Warnung. */
	const mitPrf = $derived(liste.filter((p) => p.hasPrf).length);

	/** Gekoppelt wird in der Konto-Karte; angelegt wird der Passkey im Browser. */

	async function imBrowserOeffnen() {
		try {
			await openExternal(account.serverUrl);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Browser konnte nicht geöffnet werden");
		}
	}

</script>

{#if account.linked}
	<Card.Root>
		<Card.Header>
			<Card.Title>Passkeys</Card.Title>
			<Card.Description>
				Die Wege in dein Konto. Mehr als einer ist keine Bequemlichkeit, sondern die
				Absicherung gegen den Tag, an dem ein Gerät kaputtgeht.
			</Card.Description>
		</Card.Header>

		<Card.Content class="space-y-4">
			{#if !geladen}
				<p class="text-muted-foreground text-sm">Lädt…</p>
			{:else}
				{#if liste.length === 1}
					<div class="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
						<p class="font-medium">Nur ein Passkey.</p>
						<p class="text-muted-foreground mt-1 text-xs">
							Geht dieses Gerät verloren oder wird getauscht, kommst du nur noch über die
							Wiederherstellungs-Phrase hinein. Leg jetzt einen zweiten an – auf dem Handy oder
							einem Sicherheitsschlüssel.
						</p>
					</div>
				{/if}

				<div class="space-y-1">
					{#each liste as p (p.id)}
						<div class="flex items-center justify-between gap-2 border-b py-2 text-sm last:border-0">
							<div class="min-w-0">
								{#if benennt === p.id}
									<div class="flex flex-wrap gap-1">
										<Input bind:value={neuerName} class="h-8 w-40 sm:w-48" placeholder="z. B. Handy" />
										<Button size="sm" onclick={() => umbenennen(p.id)}>Speichern</Button>
										<Button variant="ghost" size="sm" onclick={() => (benennt = null)}>
											Abbrechen
										</Button>
									</div>
								{:else}
									<p class="flex flex-wrap items-center gap-1.5 font-medium">
										<span class="truncate">{p.label ?? "Unbenannt"}</span>
										{#if !p.hasPrf}
											<Badge
												variant="outline"
												title="Ohne die Passkey-Erweiterung PRF: die Anmeldung klappt, den Tresor öffnet dieser Passkey aber nicht von allein."
											>
												öffnet die Daten nicht allein
											</Badge>
										{/if}
									</p>
									<p class="text-muted-foreground text-xs">
										angelegt {fmtDateHuman(p.createdAt)}
										{#if p.lastUsedAt}
											· zuletzt benutzt {fmtDateHuman(p.lastUsedAt)}
										{:else}
											· noch nie benutzt
										{/if}
									</p>
								{/if}
							</div>

							{#if benennt !== p.id}
								<div class="flex shrink-0 gap-1">
									<Button
										variant="ghost"
										size="sm"
										onclick={() => {
											benennt = p.id;
											neuerName = p.label ?? "";
										}}
									>
										Umbenennen
									</Button>
									{#if liste.length > 1}
										<Button variant="ghost" size="sm" onclick={() => (entfernt = p)}>Entfernen</Button>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>

				{#if mitPrf === 0 && liste.length > 0}
					<p class="text-muted-foreground text-xs">
						Keiner dieser Passkeys kann den Tresor allein öffnen – zum Entsperren braucht es
						zusätzlich die Wiederherstellungs-Phrase oder ein bereits entsperrtes Gerät.
					</p>
				{/if}

				{#if isTauri()}
					<div class="space-y-2 border-t pt-3">
						<p class="text-muted-foreground text-sm">
							Ein Passkey lässt sich nur im Browser einrichten, nicht in dieser Anwendung.
							Erstelle dazu dein Konto im Browser.
						</p>
						<Button variant="outline" size="sm" onclick={imBrowserOeffnen} disabled={!account.serverUrl}>
							Im Browser öffnen
						</Button>
					</div>
				{:else}
					<div class="space-y-2 border-t pt-3">
						<Label for="pkname">Namen für den neuen Passkey</Label>
						<div class="flex gap-2">
							<Input id="pkname" bind:value={name} placeholder="z. B. Handy" class="w-56" />
							<Button onclick={hinzufuegen} disabled={laeuft}>
								{laeuft ? "Wartet auf Bestätigung…" : "Passkey hinzufügen"}
							</Button>
						</div>
						<p class="text-muted-foreground text-xs">
							Am besten auf einem anderen Gerät als diesem.
						</p>
					</div>
				{/if}
			{/if}
		</Card.Content>
	</Card.Root>
{/if}

<Dialog.Root open={entfernt !== null} onOpenChange={(o) => !o && (entfernt = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>„{entfernt?.label ?? 'Unbenannt'}" entfernen?</Dialog.Title>
			<Dialog.Description>
				Dieser Weg ins Konto fällt damit weg. Der Passkey selbst bleibt auf dem Gerät liegen,
				öffnet hier aber nichts mehr – zurückholen lässt er sich nur, indem du ihn neu anlegst.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (entfernt = null)}>Abbrechen</Button>
			<Button variant="destructive" onclick={entfernenBestaetigt}>Entfernen</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
