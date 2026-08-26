<script lang="ts">
	// Verwaltung: Einladungen vergeben.
	//
	// Erscheint nur bei einem Konto, das dazu berechtigt ist - und "berechtigt"
	// entscheidet der Server, nicht diese Datei. Wer die Karte per Werkzeugkasten
	// sichtbar macht, bekommt von jedem Endpunkt dahinter eine Absage.
	//
	// Was ein Verwalter kann, ist absichtlich schmal: Einladungen ausstellen,
	// ansehen, zurueckziehen. Fremde Daten lesen kann er nicht - das kann der
	// Server selbst nicht.
	import * as Card from "$lib/components/ui/card";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { toast } from "svelte-sonner";
	import { account } from "$lib/sync/account.svelte";
	import type { Invite } from "$lib/sync/api";
	import { fmtDateHuman } from "$lib/time";

	let liste = $state<Invite[]>([]);
	let geladen = $state(false);
	let laeuft = $state(false);
	let notiz = $state("");
	let tage = $state("");
	/** Der zuletzt ausgestellte Code - gross, zum Abschreiben oder Vorlesen. */
	let frisch = $state("");

	async function laden() {
		try {
			liste = await account.invites();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Einladungen nicht abrufbar");
		} finally {
			geladen = true;
		}
	}

	$effect(() => {
		if (account.isAdmin && !geladen) void laden();
	});

	async function ausstellen() {
		laeuft = true;
		try {
			const neu = await account.createInvite({
				note: notiz.trim() || undefined,
				gueltigTage: tage ? Number(tage) : undefined
			});
			frisch = neu.code;
			notiz = "";
			tage = "";
			await laden();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Ausstellen fehlgeschlagen");
		} finally {
			laeuft = false;
		}
	}

	async function zurueckziehen(code: string) {
		try {
			await account.revokeInvite(code);
			if (frisch === code) frisch = "";
			await laden();
			toast.success("Einladung zurückgezogen.");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Zurückziehen fehlgeschlagen");
		}
	}

	/** Was mit dieser Einladung los ist - in einem Wort. */
	function stand(i: Invite): { text: string; ton: string } {
		if (i.usedAt) return { text: `benutzt ${fmtDateHuman(i.usedAt)}`, ton: "text-muted-foreground" };
		if (i.revokedAt) return { text: "zurückgezogen", ton: "text-muted-foreground" };
		if (i.expiresAt && i.expiresAt < Date.now()) {
			return { text: "abgelaufen", ton: "text-muted-foreground" };
		}
		if (i.expiresAt) return { text: `offen bis ${fmtDateHuman(i.expiresAt)}`, ton: "text-emerald-600" };
		return { text: "offen", ton: "text-emerald-600" };
	}

	const offen = $derived(
		liste.filter((i) => !i.usedAt && !i.revokedAt && (!i.expiresAt || i.expiresAt > Date.now()))
	);
</script>

{#if account.isAdmin}
	<Card.Root>
		<Card.Header>
			<Card.Title>Verwaltung</Card.Title>
			<Card.Description>
				Einladungen vergeben. Mehr nicht – auch als Verwalter sind fremde Daten nicht lesbar.
			</Card.Description>
		</Card.Header>

		<Card.Content class="space-y-4">
			{#if frisch}
				<div class="bg-muted space-y-1 rounded-md p-3">
					<p class="text-sm">Neue Einladung – gilt genau einmal:</p>
					<p class="font-mono text-xl tracking-wider select-all">{frisch}</p>
					<p class="text-muted-foreground text-xs">
						Weitergeben und dann vergessen. Sie taucht unten in der Liste wieder auf.
					</p>
				</div>
			{/if}

			<div class="space-y-2">
				<div class="grid gap-2 sm:grid-cols-[1fr_auto]">
					<div class="space-y-1">
						<Label for="inote">Wofür? (optional)</Label>
						<Input id="inote" bind:value={notiz} placeholder="z. B. Kollege aus dem Team" />
					</div>
					<div class="space-y-1">
						<Label for="itage">Gültig (Tage)</Label>
						<Input id="itage" bind:value={tage} type="number" min="1" placeholder="∞" class="w-28" />
					</div>
				</div>
				<Button onclick={ausstellen} disabled={laeuft}>
					{laeuft ? "Stellt aus…" : "Einladung ausstellen"}
				</Button>
			</div>

			<div class="border-t pt-3">
				<p class="mb-2 text-sm font-medium">
					Einladungen
					{#if offen.length > 0}
						<span class="text-muted-foreground font-normal">– {offen.length} offen</span>
					{/if}
				</p>

				{#if !geladen}
					<p class="text-muted-foreground text-sm">Lädt…</p>
				{:else if liste.length === 0}
					<p class="text-muted-foreground text-sm">
						Noch keine ausgestellt. Solange niemand eine hat, kommt auch niemand herein.
					</p>
				{:else}
					<div class="space-y-1">
						{#each liste as i (i.code)}
							{@const s = stand(i)}
							<div class="flex items-center justify-between gap-2 text-sm">
								<div class="min-w-0">
									<span class="font-mono">{i.code}</span>
									{#if i.note}
										<span class="text-muted-foreground truncate"> · {i.note}</span>
									{/if}
								</div>
								<div class="flex shrink-0 items-center gap-2">
									<span class="text-xs {s.ton}">{s.text}</span>
									{#if !i.usedAt && !i.revokedAt}
										<Button
											variant="ghost"
											size="sm"
											onclick={() => zurueckziehen(i.code)}
										>
											Zurückziehen
										</Button>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</Card.Content>
	</Card.Root>
{/if}
