<script lang="ts">
	// Passkeys verwalten.
	import * as Card from "$lib/components/ui/card";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { toast } from "svelte-sonner";
	import { account } from "$lib/sync/account.svelte";
	import type { Passkey } from "$lib/sync/api";
	import { fmtDateHuman } from "$lib/time";
	import { isTauri } from "$lib/platform/env";

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

	async function entfernen(p: Passkey) {
		try {
			await account.removePasskey(p.id);
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
					<div class="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
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
									<div class="flex gap-1">
										<Input bind:value={neuerName} class="h-8 w-48" placeholder="z. B. Handy" />
										<Button size="sm" onclick={() => umbenennen(p.id)}>Speichern</Button>
										<Button variant="ghost" size="sm" onclick={() => (benennt = null)}>
											Abbrechen
										</Button>
									</div>
								{:else}
									<p class="truncate font-medium">
										{p.label ?? "Unbenannt"}
										{#if !p.hasPrf}
											<span class="text-muted-foreground font-normal"> · öffnet die Daten nicht allein</span>
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
										<Button variant="ghost" size="sm" onclick={() => entfernen(p)}>Entfernen</Button>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>

				{#if mitPrf === 0 && liste.length > 0}
					<p class="text-muted-foreground text-xs">
						Keiner dieser Passkeys kann den Tresor allein öffnen – zum Entsperren braucht es
						zusätzlich die Wiederherstellungs-Phrase oder ein bereits entsperrtes Gerät. Das liegt
						am Authentifikator, nicht an dir.
					</p>
				{/if}

				{#if isTauri()}
					<div class="border-t pt-3">
						<p class="text-muted-foreground text-sm">
							Ein Passkey hängt an der Adresse des Servers – die Desktop-Anwendung hat keine.
							Anlegen und Entfernen geht deshalb nur im Browser. Ein weiterer <em>Rechner</em>
							kommt über die Kopplung dazu, nicht über einen Passkey.
						</p>
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
							Am besten auf einem anderen Gerät als diesem – ein zweiter Schlüssel im selben
							Schloss hilft nicht.
						</p>
					</div>
				{/if}
			{/if}
		</Card.Content>
	</Card.Root>
{/if}
