<script lang="ts">
	import * as Card from "$lib/components/ui/card";
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
	import { toast } from "svelte-sonner";
	import { account } from "$lib/sync/account.svelte";
	import { errorText } from "$lib/log";

	const fehlertext = (e: unknown, standard: string) =>
		e instanceof Error ? errorText(e) : standard;

	let laeuft = $state(false);
	let loesenModalOffen = $state(false);
	let revokeModalOffen = $state(false);
	let aufloesenModalOffen = $state(false);
	let geraeteAmKonto = $state<number | null>(null);

	async function aufloesenDialogOeffnen() {
		aufloesenModalOffen = true;
		geraeteAmKonto = null;
		try {
			const info = await account.accountInfo();
			geraeteAmKonto = info ? info.devices.filter((d) => !d.revokedAt).length : null;
		} catch {
			geraeteAmKonto = null;
		}
	}

	async function lokalLoesenBestaetigt() {
		laeuft = true;
		try {
			await account.unlink();
			loesenModalOffen = false;
			toast.success("Verknüpfung gelöst. Deine erfassten Zeiten bleiben auf diesem Gerät erhalten.");
		} catch (e) {
			toast.error(fehlertext(e, "Entkoppeln fehlgeschlagen"));
		} finally {
			laeuft = false;
		}
	}

	async function revokeBestaetigt() {
		laeuft = true;
		try {
			await account.unlink({ revokeSelf: true });
			revokeModalOffen = false;
			toast.success("Gerät vom Konto getrennt. Deine erfassten Zeiten bleiben auf diesem Gerät erhalten.");
		} catch (e) {
			toast.error(fehlertext(e, "Trennen fehlgeschlagen"));
		} finally {
			laeuft = false;
		}
	}

	async function aufloesenBestaetigt() {
		laeuft = true;
		try {
			const summe = await account.unlink({ deleteRemote: true });
			aufloesenModalOffen = false;
			toast.success(
				summe
					? `Konto aufgelöst. ${summe.records} Datensätze beim Server gelöscht. Die Zeiten bleiben hier.`
					: "Konto aufgelöst. Die Zeiten bleiben hier."
			);
		} catch (e) {
			toast.error(fehlertext(e, "Auflösen fehlgeschlagen"));
		} finally {
			laeuft = false;
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
					disabled={laeuft}
					onclick={() => (loesenModalOffen = true)}
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
						disabled={laeuft}
						onclick={() => (revokeModalOffen = true)}
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
					disabled={laeuft}
					onclick={aufloesenDialogOeffnen}
				>
					Konto auflösen…
				</Button>
			</div>
		</Card.Content>
	</Card.Root>

	<!-- Modal 1: Lokal entkoppeln -->
	<Dialog.Root open={loesenModalOffen} onOpenChange={(o) => !o && (loesenModalOffen = false)}>
		<Dialog.Content class="sm:max-w-md">
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
				<Button variant="outline" disabled={laeuft} onclick={() => (loesenModalOffen = false)}>
					Abbrechen
				</Button>
				<Button disabled={laeuft} onclick={lokalLoesenBestaetigt}>
					{laeuft ? "Trennt…" : "Lokal entkoppeln"}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>

	<!-- Modal 2: Gerätezugang auf Server widerrufen -->
	<Dialog.Root open={revokeModalOffen} onOpenChange={(o) => !o && (revokeModalOffen = false)}>
		<Dialog.Content class="sm:max-w-md">
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
				<Button variant="outline" disabled={laeuft} onclick={() => (revokeModalOffen = false)}>
					Abbrechen
				</Button>
				<Button variant="destructive" disabled={laeuft} onclick={revokeBestaetigt}>
					{laeuft ? "Widerruft…" : "Zugang widerrufen"}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>

	<!-- Modal 3: Server-Konto endgültig auflösen -->
	<Dialog.Root open={aufloesenModalOffen} onOpenChange={(o) => !o && (aufloesenModalOffen = false)}>
		<Dialog.Content class="sm:max-w-md">
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
						{#if geraeteAmKonto && geraeteAmKonto > 1}
							<strong class="text-foreground block mt-1">Dies betrifft alle {geraeteAmKonto} verknüpften Geräte.</strong>
						{/if}
					</p>
					<p class="text-foreground text-xs font-medium border-t pt-2">
						✓ Deine bisher auf diesem Rechner erfassten Zeiten bleiben als lokale Kopie vollständig erhalten.
					</p>
				</Dialog.Description>
			</Dialog.Header>
			<Dialog.Footer class="gap-2 sm:gap-0">
				<Button variant="outline" disabled={laeuft} onclick={() => (aufloesenModalOffen = false)}>
					Abbrechen
				</Button>
				<Button variant="destructive" disabled={laeuft} onclick={aufloesenBestaetigt}>
					{laeuft ? "Löscht…" : "Ja, Server-Konto endgültig löschen"}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
{/if}

