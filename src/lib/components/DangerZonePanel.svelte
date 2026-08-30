<script lang="ts">
	import * as Card from "$lib/components/ui/card";
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
	import { toast } from "svelte-sonner";
	import { account } from "$lib/sync/account.svelte";
	import { errorText } from "$lib/log";

	const formatError = (e: unknown, fallback: string) =>
		e instanceof Error ? errorText(e) : fallback;

	let isLoading = $state(false);
	let isUnlinkModalOpen = $state(false);
	let isRevokeModalOpen = $state(false);
	let isDeleteAccountModalOpen = $state(false);
	let linkedDeviceCount = $state<number | null>(null);

	async function handleOpenDeleteAccountDialog() {
		isDeleteAccountModalOpen = true;
		linkedDeviceCount = null;
		try {
			const info = await account.accountInfo();
			linkedDeviceCount = info ? info.devices.filter((d) => !d.revokedAt).length : null;
		} catch {
			linkedDeviceCount = null;
		}
	}

	async function handleConfirmUnlink() {
		isLoading = true;
		try {
			await account.unlink();
			isUnlinkModalOpen = false;
			toast.success("Verknüpfung gelöst. Deine erfassten Zeiten bleiben auf diesem Gerät erhalten.");
		} catch (e) {
			toast.error(formatError(e, "Entkoppeln fehlgeschlagen"));
		} finally {
			isLoading = false;
		}
	}

	async function handleConfirmRevoke() {
		isLoading = true;
		try {
			await account.unlink({ revokeSelf: true });
			isRevokeModalOpen = false;
			toast.success("Gerät vom Konto getrennt. Deine erfassten Zeiten bleiben auf diesem Gerät erhalten.");
		} catch (e) {
			toast.error(formatError(e, "Trennen fehlgeschlagen"));
		} finally {
			isLoading = false;
		}
	}

	async function handleConfirmDeleteAccount() {
		isLoading = true;
		try {
			const summary = await account.unlink({ deleteRemote: true });
			isDeleteAccountModalOpen = false;
			toast.success(
				summary
					? `Konto aufgelöst. ${summary.records} Datensätze beim Server gelöscht. Die Zeiten bleiben hier.`
					: "Konto aufgelöst. Die Zeiten bleiben hier."
			);
		} catch (e) {
			toast.error(formatError(e, "Auflösen fehlgeschlagen"));
		} finally {
			isLoading = false;
		}
	}
</script>

{#if account.linked}
	<Card.Root class="border-destructive/30 bg-destructive/5 dark:bg-destructive/10">
		<Card.Header>
			<div class="flex items-center gap-2">
				<TriangleAlertIcon class="text-destructive size-5 shrink-0" />
				<Card.Title class="text-destructive">Gefahrenbereich</Card.Title>
			</div>
			<Card.Description>
				Verbindung trennen oder Server-Konto löschen. Deine lokal erfassten Zeiten bleiben immer vollständig auf diesem Rechner erhalten.
			</Card.Description>
		</Card.Header>

		<Card.Content class="space-y-2.5">
			<div class="flex flex-col gap-2 rounded-md border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
				<div class="space-y-0.5">
					<p class="font-medium text-foreground text-sm">Lokal entkoppeln</p>
					<p class="text-muted-foreground text-xs">
						Trennt dieses Gerät vom Server. Lokale Daten bleiben erhalten, andere Geräte laufen weiter.
					</p>
				</div>
				<Button
					variant="outline"
					size="sm"
					class="shrink-0 self-start sm:self-center"
					disabled={isLoading}
					onclick={() => (isUnlinkModalOpen = true)}
				>
					Entkoppeln…
				</Button>
			</div>

			{#if account.hasDeviceToken}
				<div class="flex flex-col gap-2 rounded-md border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
					<div class="space-y-0.5">
						<p class="font-medium text-foreground text-sm">Gerätezugang widerrufen</p>
						<p class="text-muted-foreground text-xs">
							Löscht das Token dieses Geräts auf dem Server und trennt die Verbindung.
						</p>
					</div>
					<Button
						variant="outline"
						size="sm"
						class="shrink-0 self-start border-destructive/40 text-destructive hover:bg-destructive/10 sm:self-center"
						disabled={isLoading}
						onclick={() => (isRevokeModalOpen = true)}
					>
						Zugang widerrufen…
					</Button>
				</div>
			{/if}

			<div class="flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 sm:flex-row sm:items-center sm:justify-between">
				<div class="space-y-0.5">
					<p class="font-medium text-destructive text-sm">Konto & Cloud-Daten löschen</p>
					<p class="text-muted-foreground text-xs">
						Löscht das gesamte Server-Konto und alle Datensätze unwiderruflich vom Server.
					</p>
				</div>
				<Button
					variant="destructive"
					size="sm"
					class="shrink-0 self-start sm:self-center"
					disabled={isLoading}
					onclick={handleOpenDeleteAccountDialog}
				>
					Konto auflösen…
				</Button>
			</div>
		</Card.Content>
	</Card.Root>

	<!-- Modal 1: Lokal entkoppeln -->
	<Dialog.Root
		open={isUnlinkModalOpen}
		onOpenChange={(o) => {
			if (!o && !isLoading) isUnlinkModalOpen = false;
		}}
	>
		<Dialog.Content
			class="sm:max-w-md"
			showCloseButton={!isLoading}
			interactOutsideBehavior={isLoading ? "ignore" : "close"}
			escapeKeydownBehavior={isLoading ? "ignore" : "close"}
		>
			<Dialog.Header>
				<Dialog.Title>Dieses Gerät lokal entkoppeln?</Dialog.Title>
				<Dialog.Description class="space-y-2 pt-2 text-left">
					<p>
						Die automatische Synchronisierung auf diesem Gerät wird beendet.
					</p>
					<p class="text-foreground text-xs font-medium">
						✓ Alle erfassten Zeiten und Einstellungen bleiben lokal auf diesem Rechner erhalten.<br />
						✓ Dein Server-Konto und alle weiteren Geräte bleiben unverändert aktiv.<br />
						✓ Du kannst dieses Gerät jederzeit wieder neu verbinden.
					</p>
				</Dialog.Description>
			</Dialog.Header>
			<Dialog.Footer class="gap-2 sm:gap-0">
				<Button variant="outline" disabled={isLoading} onclick={() => (isUnlinkModalOpen = false)}>
					Abbrechen
				</Button>
				<Button disabled={isLoading} onclick={handleConfirmUnlink}>
					{isLoading ? "Trennt…" : "Lokal entkoppeln"}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>

	<!-- Modal 2: Gerätezugang auf Server widerrufen -->
	<Dialog.Root
		open={isRevokeModalOpen}
		onOpenChange={(o) => {
			if (!o && !isLoading) isRevokeModalOpen = false;
		}}
	>
		<Dialog.Content
			class="sm:max-w-md"
			showCloseButton={!isLoading}
			interactOutsideBehavior={isLoading ? "ignore" : "close"}
			escapeKeydownBehavior={isLoading ? "ignore" : "close"}
		>
			<Dialog.Header>
				<Dialog.Title>Gerätezugang auf dem Server widerrufen?</Dialog.Title>
				<Dialog.Description class="space-y-2 pt-2 text-left">
					<p>
						Das Autorisierungs-Token dieses Geräts wird auf dem Server gelöscht und die lokale Verknüpfung entfernt.
					</p>
					<p class="text-foreground text-xs font-medium">
						✓ Die Zeiten auf diesem Rechner bleiben vollständig erhalten.<br />
						✓ Das Server-Konto und alle anderen Geräte bleiben aktiv.<br />
						✓ Für eine erneute Verbindung ist eine neue Kopplung erforderlich.
					</p>
				</Dialog.Description>
			</Dialog.Header>
			<Dialog.Footer class="gap-2 sm:gap-0">
				<Button variant="outline" disabled={isLoading} onclick={() => (isRevokeModalOpen = false)}>
					Abbrechen
				</Button>
				<Button variant="destructive" disabled={isLoading} onclick={handleConfirmRevoke}>
					{isLoading ? "Widerruft…" : "Zugang widerrufen"}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>

	<!-- Modal 3: Server-Konto endgültig auflösen -->
	<Dialog.Root
		open={isDeleteAccountModalOpen}
		onOpenChange={(o) => {
			if (!o && !isLoading) isDeleteAccountModalOpen = false;
		}}
	>
		<Dialog.Content
			class="sm:max-w-md"
			showCloseButton={!isLoading}
			interactOutsideBehavior={isLoading ? "ignore" : "close"}
			escapeKeydownBehavior={isLoading ? "ignore" : "close"}
		>
			<Dialog.Header>
				<Dialog.Title class="text-destructive flex items-center gap-2">
					<TriangleAlertIcon class="size-5 shrink-0" />
					Server-Konto endgültig löschen?
				</Dialog.Title>
				<Dialog.Description class="space-y-2 pt-2 text-left">
					<p class="text-destructive font-medium">
						Dieser Vorgang kann nicht rückgängig gemacht werden.
					</p>
					<p>
						Alle verschlüsselten Datensätze, Passkeys und hinterlegten Geräte werden unwiderruflich vom Server gelöscht.
						{#if linkedDeviceCount && linkedDeviceCount > 1}
							<strong class="text-foreground block mt-1">Dies betrifft alle {linkedDeviceCount} verknüpften Geräte.</strong>
						{/if}
					</p>
					<p class="text-foreground text-xs font-medium border-t pt-2">
						✓ Deine bisher auf diesem Rechner erfassten Zeiten bleiben als lokale Kopie vollständig erhalten.
					</p>
				</Dialog.Description>
			</Dialog.Header>
			<Dialog.Footer class="gap-2 sm:gap-0">
				<Button variant="outline" disabled={isLoading} onclick={() => (isDeleteAccountModalOpen = false)}>
					Abbrechen
				</Button>
				<Button variant="destructive" disabled={isLoading} onclick={handleConfirmDeleteAccount}>
					{isLoading ? "Löscht…" : "Ja, Server-Konto endgültig löschen"}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
{/if}
