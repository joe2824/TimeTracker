<script lang="ts">
	import * as Card from "$lib/components/ui/card";
	import ConfirmDialog from "$lib/components/shared/ConfirmDialog.svelte";
	import { Button } from "$lib/components/ui/button";
	import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
	import { toast } from "svelte-sonner";
	import { account } from "$lib/sync/account.svelte";
	import { chefTeams } from "$lib/team/chef.svelte";
	import { userErrorText } from "$lib/log";

	let isUnlinkModalOpen = $state(false);
	let isRevokeModalOpen = $state(false);
	let isDeleteAccountModalOpen = $state(false);
	let linkedDeviceCount = $state<number | null>(null);
	let ownedTeamCount = $state(0);
	/** Ob du Chef eines Teams bist, liess sich nicht prüfen - dann ein allgemeiner Hinweis. */
	let teamsUnknown = $state(false);

	async function handleOpenDeleteAccountDialog() {
		isDeleteAccountModalOpen = true;
		linkedDeviceCount = null;
		ownedTeamCount = 0;
		teamsUnknown = false;
		void chefTeams.loadTeams().then((ok) => {
			teamsUnknown = !ok;
			ownedTeamCount = ok ? chefTeams.teams.filter((t) => t.role !== "admin").length : 0;
		});
		try {
			const info = await account.accountInfo();
			linkedDeviceCount = info ? info.devices.filter((d) => !d.revokedAt).length : null;
		} catch {
			linkedDeviceCount = null;
		}
	}

	async function handleConfirmUnlink() {
		try {
			await account.unlink();
			isUnlinkModalOpen = false;
			toast.success("Verknüpfung gelöst. Deine erfassten Zeiten bleiben auf diesem Gerät erhalten.");
		} catch (e) {
			toast.error(userErrorText(e, "Entkoppeln fehlgeschlagen"));
		}
	}

	async function handleConfirmRevoke() {
		try {
			await account.unlink({ revokeSelf: true });
			isRevokeModalOpen = false;
			toast.success("Gerät vom Konto getrennt. Deine erfassten Zeiten bleiben auf diesem Gerät erhalten.");
		} catch (e) {
			toast.error(userErrorText(e, "Trennen fehlgeschlagen"));
		}
	}

	async function handleConfirmDeleteAccount() {
		try {
			const summary = await account.unlink({ deleteRemote: true });
			isDeleteAccountModalOpen = false;
			const handedOver = summary?.teamsTransferred
				? ` ${summary.teamsTransferred === 1 ? "Ein Team wird" : `${summary.teamsTransferred} Teams werden`} jetzt von einem bisherigen Verwalter geleitet.`
				: "";
			toast.success(
				summary
					? `Konto aufgelöst. ${summary.records} Datensätze beim Server gelöscht. Die Zeiten bleiben hier.${handedOver}`
					: "Konto aufgelöst. Die Zeiten bleiben hier."
			);
		} catch (e) {
			toast.error(userErrorText(e, "Auflösen fehlgeschlagen"));
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
					onclick={handleOpenDeleteAccountDialog}
				>
					Konto auflösen…
				</Button>
			</div>
		</Card.Content>
	</Card.Root>

	<!-- Modal 1: Lokal entkoppeln -->
	<ConfirmDialog
		open={isUnlinkModalOpen}
		class="sm:max-w-md"
		title="Dieses Gerät lokal entkoppeln?"
		confirmLabel="Lokal entkoppeln"
		busyLabel="Trennt…"
		variant="default"
		onConfirm={handleConfirmUnlink}
		onClose={() => (isUnlinkModalOpen = false)}
	>
		{#snippet description()}
			<span class="block space-y-2 pt-2 text-left">
				<span class="block">
					Die automatische Synchronisierung auf diesem Gerät wird beendet.
				</span>
				<span class="text-foreground block text-xs font-medium">
					✓ Alle erfassten Zeiten und Einstellungen bleiben lokal auf diesem Rechner erhalten.<br />
					✓ Dein Server-Konto und alle weiteren Geräte bleiben unverändert aktiv.<br />
					✓ Du kannst dieses Gerät jederzeit wieder neu verbinden.
				</span>
			</span>
		{/snippet}
	</ConfirmDialog>

	<!-- Modal 2: Gerätezugang auf Server widerrufen -->
	<ConfirmDialog
		open={isRevokeModalOpen}
		class="sm:max-w-md"
		title="Gerätezugang auf dem Server widerrufen?"
		confirmLabel="Zugang widerrufen"
		busyLabel="Widerruft…"
		onConfirm={handleConfirmRevoke}
		onClose={() => (isRevokeModalOpen = false)}
	>
		{#snippet description()}
			<span class="block space-y-2 pt-2 text-left">
				<span class="block">
					Das Autorisierungs-Token dieses Geräts wird auf dem Server gelöscht und die lokale Verknüpfung entfernt.
				</span>
				<span class="text-foreground block text-xs font-medium">
					✓ Die Zeiten auf diesem Rechner bleiben vollständig erhalten.<br />
					✓ Das Server-Konto und alle anderen Geräte bleiben aktiv.<br />
					✓ Für eine erneute Verbindung ist eine neue Kopplung erforderlich.
				</span>
			</span>
		{/snippet}
	</ConfirmDialog>

	<!-- Modal 3: Server-Konto endgültig auflösen -->
	<ConfirmDialog
		open={isDeleteAccountModalOpen}
		class="sm:max-w-md"
		confirmLabel="Ja, Server-Konto endgültig löschen"
		busyLabel="Löscht…"
		onConfirm={handleConfirmDeleteAccount}
		onClose={() => (isDeleteAccountModalOpen = false)}
	>
		{#snippet title()}
			<span class="text-destructive flex items-center gap-2">
				<TriangleAlertIcon class="size-5 shrink-0" />
				Server-Konto endgültig löschen?
			</span>
		{/snippet}
		{#snippet description()}
			<span class="block space-y-2 pt-2 text-left">
				<span class="text-destructive block font-medium">
					Dieser Vorgang kann nicht rückgängig gemacht werden.
				</span>
				<span class="block">
					Alle verschlüsselten Datensätze, Passkeys und hinterlegten Geräte werden unwiderruflich vom Server gelöscht.
					{#if linkedDeviceCount && linkedDeviceCount > 1}
						<strong class="text-foreground block mt-1">Dies betrifft alle {linkedDeviceCount} verknüpften Geräte.</strong>
					{/if}
				</span>
				{#if ownedTeamCount > 0}
					<span class="text-foreground block">
						Du leitest {ownedTeamCount === 1 ? "ein Team" : `${ownedTeamCount} Teams`}. Ein Team mit
						Verwalter geht an den Verwalter über, der am längsten dabei ist. Ein Team ohne Verwalter wird
						samt Mitgliedern und Berichten gelöscht. Soll ein Team weiterlaufen, lade vorher einen
						Verwalter ein.
					</span>
				{:else if teamsUnknown}
					<span class="text-foreground block">
						Ob du ein Team leitest, ließ sich gerade nicht prüfen. Eigene Teams gehen an einen
						Verwalter über; ein Team ohne Verwalter wird mit gelöscht.
					</span>
				{/if}
				<span class="text-foreground block text-xs font-medium border-t pt-2">
					✓ Deine bisher auf diesem Rechner erfassten Zeiten bleiben als lokale Kopie vollständig erhalten.
				</span>
			</span>
		{/snippet}
	</ConfirmDialog>
{/if}
