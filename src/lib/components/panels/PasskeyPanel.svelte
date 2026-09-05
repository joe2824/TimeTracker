<script lang="ts">
	import * as Card from "$lib/components/ui/card";
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { toast } from "svelte-sonner";
	import { account } from "$lib/sync/account.svelte";
	import { ACCOUNT_KEY, invalidate, warm } from "$lib/ui/prefetch";
	import type { Passkey } from "$lib/sync/api";
	import { fmtDateHuman } from "$lib/time/time";
	import { isTauri } from "$lib/platform/env";
	import { openExternal } from "$lib/platform/open";
	import KeyRoundIcon from "@lucide/svelte/icons/key-round";
	import FingerprintIcon from "@lucide/svelte/icons/fingerprint";
	import ShieldAlertIcon from "@lucide/svelte/icons/shield-alert";
	import PencilIcon from "@lucide/svelte/icons/pencil";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";
	import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
	import { Skeleton } from "$lib/components/ui/skeleton";

	let passkeys = $state<Passkey[]>([]);
	let isLoaded = $state(false);
	let isLoading = $state(false);
	let newPasskeyName = $state("");
	let editingPasskeyId = $state<string | null>(null);
	let editingPasskeyName = $state("");

	/**
	 * Die Liste steckt schon in `accountInfo` - eine Anfrage fuer Konto, Geraete
	 * und Passkeys statt drei. `fresh` umgeht den Puffer, nachdem sich etwas
	 * geaendert hat.
	 */
	async function loadPasskeys(fresh = false) {
		try {
			if (fresh) invalidate(ACCOUNT_KEY);
			const info = await warm(ACCOUNT_KEY, () => account.accountInfo());
			passkeys = info?.passkeys ?? [];
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Passkeys nicht abrufbar");
		} finally {
			isLoaded = true;
		}
	}

	$effect(() => {
		if (account.linked && !isLoaded) void loadPasskeys();
	});

	async function handleAddPasskey() {
		isLoading = true;
		try {
			const { prfAvailable } = await account.addPasskey(newPasskeyName.trim() || "Weiterer Passkey");
			newPasskeyName = "";
			await loadPasskeys(true);
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
			isLoading = false;
		}
	}

	let passkeyToRemove = $state<Passkey | null>(null);

	async function handleConfirmRemove() {
		const target = passkeyToRemove;
		if (!target) return;
		try {
			await account.removePasskey(target.id);
			passkeyToRemove = null;
			await loadPasskeys(true);
			toast.success("Passkey entfernt.");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Entfernen fehlgeschlagen");
		}
	}

	async function handleRenamePasskey(id: string) {
		try {
			await account.renamePasskey(id, editingPasskeyName.trim());
			editingPasskeyId = null;
			await loadPasskeys(true);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Umbenennen fehlgeschlagen");
		}
	}

	const wrapCount = $derived(passkeys.filter((p) => p.hasWrap).length);

	let repairing = $state<string | null>(null);

	async function handleRepair(p: Passkey) {
		repairing = p.id;
		try {
			const r = await account.repairPasskeyWrap(p.id);
			await loadPasskeys(true);
			if (r.ok) {
				toast.success("Erledigt. Dieser Passkey entsperrt deine Daten jetzt allein.");
			} else if (r.reason === "otherPasskey") {
				toast.error("Das war ein anderer Passkey. Bitte den aus dieser Zeile bestätigen.");
			} else {
				// Kein PRF: daran aendert kein zweiter Versuch etwas, und die 24 Wörter
				// helfen hier auch nicht - den Wert kann nur der Passkey selbst liefern.
				toast.error(
					"Dieser Passkey kann deine Daten nicht entschlüsseln. Leg auf diesem Gerät einen neuen an."
				);
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Einrichten fehlgeschlagen");
		} finally {
			repairing = null;
		}
	}

	async function handleOpenInBrowser() {
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
			{#if !isLoaded}
				<div class="space-y-2">
					<Skeleton class="h-3 w-36" />
					<div class="divide-y rounded-lg border bg-card">
						{#each Array(2) as _}
							<div class="flex items-center justify-between p-3">
								<div class="flex items-center gap-3 min-w-0">
									<Skeleton class="size-8 rounded-md shrink-0" />
									<div class="space-y-1.5 min-w-0">
										<Skeleton class="h-4 w-36" />
										<Skeleton class="h-3 w-28" />
									</div>
								</div>
								<Skeleton class="h-8 w-8 rounded-md shrink-0" />
							</div>
						{/each}
					</div>
				</div>
			{:else}
				{#if passkeys.length === 1}
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
						Registrierte Passkeys ({passkeys.length})
					</Label>
					<div class="divide-y rounded-lg border bg-card">
						{#each passkeys as p (p.id)}
							<div class="flex items-center justify-between gap-3 p-3 text-sm">
								<div class="flex items-center gap-3 min-w-0">
									<div class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
										<FingerprintIcon class="size-4" />
									</div>
									<div class="min-w-0">
										{#if editingPasskeyId === p.id}
											<div class="flex items-center gap-1.5 py-0.5">
												<Input
													bind:value={editingPasskeyName}
													class="h-8 w-44 sm:w-56 text-xs"
													placeholder="z. B. Handy"
													onkeydown={(e) => e.key === "Enter" && editingPasskeyName.trim() && handleRenamePasskey(p.id)}
												/>
												<Button size="sm" class="h-8 text-xs" onclick={() => handleRenamePasskey(p.id)}>Speichern</Button>
												<Button variant="ghost" size="sm" class="h-8 text-xs" onclick={() => (editingPasskeyId = null)}>
													Abbrechen
												</Button>
											</div>
										{:else}
											<div class="flex flex-wrap items-center gap-2">
												<p class="font-medium text-foreground truncate">{p.label ?? "Unbenannt"}</p>
												{#if !p.hasWrap}
													<Badge
														variant="outline"
														class="text-[10px] px-1.5 py-0 h-4 font-normal text-muted-foreground"
														title="Die Anmeldung klappt, die Daten öffnet dieser Passkey aber nicht von allein."
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

								{#if editingPasskeyId !== p.id}
									<div class="flex shrink-0 items-center gap-1">
										{#if !p.hasWrap && !isTauri()}
											<Button
												variant="outline"
												size="sm"
												class="h-8 text-xs"
												disabled={repairing === p.id}
												title="Einmal bestätigen – danach entsperrt dieser Passkey deine Daten ohne die 24 Wörter."
												onclick={() => handleRepair(p)}
											>
												{repairing === p.id ? "…" : "Einrichten"}
											</Button>
										{/if}
										<Button
											variant="ghost"
											size="icon-sm"
											class="text-muted-foreground hover:text-foreground"
											title="Umbenennen"
											onclick={() => {
												editingPasskeyId = p.id;
												editingPasskeyName = p.label ?? "";
											}}
										>
											<PencilIcon class="size-3.5" />
										</Button>
										{#if passkeys.length > 1}
											<Button
												variant="ghost"
												size="icon-sm"
												class="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
												title="Passkey entfernen"
												onclick={() => (passkeyToRemove = p)}
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

				{#if wrapCount === 0 && passkeys.length > 0}
					<p class="text-muted-foreground text-xs">
						Keiner dieser Passkeys öffnet deine Daten allein – zum Entsperren braucht es zusätzlich
						die Wiederherstellungs-Phrase oder ein bereits entsperrtes Gerät.
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
							onclick={handleOpenInBrowser}
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
								bind:value={newPasskeyName}
								placeholder="z. B. Touch ID"
								class="w-56 text-sm"
								onkeydown={(e) => e.key === "Enter" && newPasskeyName.trim() && !isLoading && handleAddPasskey()}
							/>
							<Button onclick={handleAddPasskey} disabled={isLoading}>
								{isLoading ? "Wartet auf Bestätigung…" : "Passkey hinzufügen"}
							</Button>
						</div>
					</div>
				{/if}
			{/if}
		</Card.Content>
	</Card.Root>
{/if}

<Dialog.Root open={passkeyToRemove !== null} onOpenChange={(o) => !o && (passkeyToRemove = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>„{passkeyToRemove?.label ?? 'Unbenannt'}" entfernen?</Dialog.Title>
			<Dialog.Description>
				Dieser Weg ins Konto fällt damit weg. Der Passkey selbst bleibt auf dem Gerät liegen,
				öffnet hier aber nichts mehr – zurückholen lässt er sich nur, indem du ihn neu anlegst.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (passkeyToRemove = null)}>Abbrechen</Button>
			<Button variant="destructive" onclick={handleConfirmRemove}>Entfernen</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
