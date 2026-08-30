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
	import KeyRoundIcon from "@lucide/svelte/icons/key-round";
	import FingerprintIcon from "@lucide/svelte/icons/fingerprint";
	import ShieldAlertIcon from "@lucide/svelte/icons/shield-alert";
	import PencilIcon from "@lucide/svelte/icons/pencil";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";
	import ExternalLinkIcon from "@lucide/svelte/icons/external-link";

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
			<div class="flex items-center gap-2">
				<KeyRoundIcon class="size-5 text-primary shrink-0" />
				<Card.Title>Passkeys & Authentifizierung</Card.Title>
			</div>
			<Card.Description>
				Biometrische Zugänge (Touch ID, Face ID, Windows Hello oder YubiKey) für dein Konto.
			</Card.Description>
		</Card.Header>

		<Card.Content class="space-y-4">
			{#if !geladen}
				<p class="text-muted-foreground text-sm">Lädt…</p>
			{:else}
				{#if liste.length === 1}
					<div class="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-900 dark:text-amber-200">
						<ShieldAlertIcon class="size-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
						<div>
							<p class="font-semibold text-sm">Nur ein Passkey hinterlegt</p>
							<p class="mt-0.5 opacity-90 leading-relaxed">
								Geht dieses Gerät verloren oder wird getauscht, kommst du nur noch über die Wiederherstellungs-Phrase hinein.
								Wir empfehlen, einen zweiten Passkey anzulegen (z. B. auf dem Smartphone oder einem Sicherheitsschlüssel).
							</p>
						</div>
					</div>
				{/if}

				<div class="space-y-2">
					<Label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
						Registrierte Passkeys ({liste.length})
					</Label>
					<div class="divide-y rounded-lg border bg-card">
						{#each liste as p (p.id)}
							<div class="flex items-center justify-between gap-3 p-3 text-sm">
								<div class="flex items-center gap-3 min-w-0">
									<div class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
										<FingerprintIcon class="size-4" />
									</div>
									<div class="min-w-0">
										{#if benennt === p.id}
											<div class="flex items-center gap-1.5 py-0.5">
												<Input
													bind:value={neuerName}
													class="h-8 w-44 sm:w-56 text-xs"
													placeholder="z. B. Handy"
													onkeydown={(e) => e.key === "Enter" && neuerName.trim() && umbenennen(p.id)}
												/>
												<Button size="sm" class="h-8 text-xs" onclick={() => umbenennen(p.id)}>Speichern</Button>
												<Button variant="ghost" size="sm" class="h-8 text-xs" onclick={() => (benennt = null)}>
													Abbrechen
												</Button>
											</div>
										{:else}
											<div class="flex flex-wrap items-center gap-2">
												<p class="font-medium text-foreground truncate">{p.label ?? "Unbenannt"}</p>
												{#if !p.hasPrf}
													<Badge
														variant="outline"
														class="text-[10px] px-1.5 py-0 h-4 font-normal text-muted-foreground"
														title="Ohne die Passkey-Erweiterung PRF: die Anmeldung klappt, den Tresor öffnet dieser Passkey aber nicht von allein."
													>
														ohne direkte Entschlüsselung
													</Badge>
												{/if}
											</div>
											<p class="text-muted-foreground text-xs">
												Angelegt {fmtDateHuman(p.createdAt)}
												{#if p.lastUsedAt}
													· Zuletzt aktiv {fmtDateHuman(p.lastUsedAt)}
												{:else}
													· Noch nie benutzt
												{/if}
											</p>
										{/if}
									</div>
								</div>

								{#if benennt !== p.id}
									<div class="flex shrink-0 items-center gap-1">
										<Button
											variant="ghost"
											size="icon-sm"
											class="text-muted-foreground hover:text-foreground"
											title="Umbenennen"
											onclick={() => {
												benennt = p.id;
												neuerName = p.label ?? "";
											}}
										>
											<PencilIcon class="size-3.5" />
										</Button>
										{#if liste.length > 1}
											<Button
												variant="ghost"
												size="icon-sm"
												class="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
												title="Passkey entfernen"
												onclick={() => (entfernt = p)}
											>
												<Trash2Icon class="size-3.5" />
											</Button>
										{/if}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				</div>

				{#if mitPrf === 0 && liste.length > 0}
					<p class="text-muted-foreground text-xs">
						Keiner dieser Passkeys kann den Tresor allein öffnen – zum Entsperren braucht es
						zusätzlich die Wiederherstellungs-Phrase oder ein bereits entsperrtes Gerät.
					</p>
				{/if}

				{#if isTauri()}
					<div class="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3.5 sm:flex-row sm:items-center sm:justify-between">
						<div class="space-y-0.5">
							<p class="font-medium text-sm text-foreground">Weiteren Passkey hinzufügen</p>
							<p class="text-muted-foreground text-xs">
								Passkeys werden im Web-Browser eingerichtet und direkt mit deinem Server synchronisiert.
							</p>
						</div>
						<Button
							variant="outline"
							size="sm"
							class="shrink-0 self-start sm:self-center gap-1.5"
							onclick={imBrowserOeffnen}
							disabled={!account.serverUrl}
						>
							<ExternalLinkIcon class="size-3.5" />
							Im Browser öffnen
						</Button>
					</div>
				{:else}
					<div class="space-y-2 rounded-lg border bg-muted/20 p-3.5">
						<div>
							<Label for="pkname" class="font-medium text-sm text-foreground">Weiteren Passkey hinzufügen</Label>
							<p class="text-muted-foreground text-xs">
								Erstelle einen neuen biometrischen Passkey auf diesem Gerät.
							</p>
						</div>
						<div class="flex flex-wrap gap-2 pt-1">
							<Input
								id="pkname"
								bind:value={name}
								placeholder="z. B. Touch ID"
								class="w-56 text-sm"
								onkeydown={(e) => e.key === "Enter" && name.trim() && !laeuft && hinzufuegen()}
							/>
							<Button onclick={hinzufuegen} disabled={laeuft}>
								{laeuft ? "Wartet auf Bestätigung…" : "Passkey hinzufügen"}
							</Button>
						</div>
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
