<script lang="ts">
	import * as Card from "$lib/components/ui/card";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { toast } from "svelte-sonner";
	import { account } from "$lib/sync/account.svelte";
	import type { Invite } from "$lib/sync/api";
	import { fmtDateHuman } from "$lib/time";
	import { inviteLink } from "$lib/invite";
	import LinkIcon from "@lucide/svelte/icons/link";
	import CopyIcon from "@lucide/svelte/icons/copy";
	import CheckIcon from "@lucide/svelte/icons/check";
	import ShieldAlertIcon from "@lucide/svelte/icons/shield-alert";
	import ShieldCheckIcon from "@lucide/svelte/icons/shield-check";

	let liste = $state<Invite[]>([]);
	let geladen = $state(false);
	let laeuft = $state(false);
	let envConfigured = $state(false);
	let envActive = $state(true);
	let envLaeuft = $state(false);
	let notiz = $state("");
	let tage = $state("");
	/** Der zuletzt ausgestellte Code - gross, zum Abschreiben oder Vorlesen. */
	let frisch = $state("");
	let linkKopiert = $state(false);
	let codeKopiert = $state(false);

	/** In die Zwischenablage, mit sichtbarer Rueckmeldung am Knopf. */
	async function inDieAblage(text: string, melden: (an: boolean) => void) {
		try {
			await navigator.clipboard.writeText(text);
			melden(true);
			setTimeout(() => melden(false), 2000);
		} catch {
			toast.error("Kopieren nicht möglich – bitte von Hand markieren.");
		}
	}

	// Die eigene Adresse: im Browser ist sie der Server, in der Anwendung steht
	// sie in der Verknuepfung.
	const basis = $derived(
		account.serverUrl || (typeof location !== "undefined" ? location.origin : "")
	);

	const linkKopieren = (code: string) =>
		inDieAblage(inviteLink(basis, code), (an) => (linkKopiert = an));
	const codeKopieren = (code: string) => inDieAblage(code, (an) => (codeKopiert = an));

	async function laden() {
		try {
			const res = await account.invites();
			liste = res.invites;
			envConfigured = res.envInvitesConfigured;
			envActive = res.envInvitesActive;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Einladungen nicht abrufbar");
		} finally {
			geladen = true;
		}
	}

	$effect(() => {
		if (account.isAdmin && !geladen) void laden();
	});

	async function toggleEnvInvites() {
		envLaeuft = true;
		const ziel = !envActive;
		try {
			envActive = await account.setEnvInvites(ziel);
			if (!envActive) {
				toast.success("Statische Einladungscodes (.env) wurden deaktiviert.");
			} else {
				toast.success("Statische Einladungscodes (.env) wurden wieder aktiviert.");
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Änderung fehlgeschlagen");
		} finally {
			envLaeuft = false;
		}
	}

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
	function stand(i: Invite): { text: string; offen: boolean } {
		if (i.usedAt) return { text: `benutzt ${fmtDateHuman(i.usedAt)}`, offen: false };
		if (i.revokedAt) return { text: "zurückgezogen", offen: false };
		if (i.expiresAt && i.expiresAt < Date.now()) {
			return { text: "abgelaufen", offen: false };
		}
		if (i.expiresAt) return { text: `offen bis ${fmtDateHuman(i.expiresAt)}`, offen: true };
		return { text: "offen", offen: true };
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
			{#if envConfigured}
				{#if envActive}
					<div class="border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200 flex flex-col gap-2 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
						<div class="flex items-start gap-2">
							<ShieldAlertIcon class="text-amber-600 dark:text-amber-400 mt-0.5 size-5 shrink-0" />
							<div>
								<p class="font-medium">Statische Einladungscodes (.env) sind aktiv</p>
								<p class="text-xs opacity-90">
									Der Server akzeptiert noch statische Codes aus der Konfiguration. Sobald alle Administratoren eingerichtet sind, sollten diese deaktiviert werden.
								</p>
							</div>
						</div>
						<Button
							variant="destructive"
							size="sm"
							class="shrink-0 self-start sm:self-center"
							onclick={toggleEnvInvites}
							disabled={envLaeuft}
						>
							{envLaeuft ? "Wird deaktiviert…" : "Codes jetzt deaktivieren"}
						</Button>
					</div>
				{:else}
					<div class="border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200 flex flex-col gap-2 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
						<div class="flex items-start gap-2">
							<ShieldCheckIcon class="text-emerald-600 dark:text-emerald-400 mt-0.5 size-5 shrink-0" />
							<div>
								<p class="font-medium">Statische Einladungscodes (.env) sind deaktiviert</p>
								<p class="text-xs opacity-90">
									Nur noch individuell erstellte Einladungen aus der Liste unten werden akzeptiert.
								</p>
							</div>
						</div>
						<Button
							variant="outline"
							size="sm"
							class="shrink-0 self-start sm:self-center"
							onclick={toggleEnvInvites}
							disabled={envLaeuft}
						>
							{envLaeuft ? "Wird aktiviert…" : "Wieder aktivieren"}
						</Button>
					</div>
				{/if}
			{:else}
				<div class="border-border/60 bg-muted/40 text-muted-foreground flex items-center justify-between rounded-lg border p-3 text-sm">
					<div class="flex items-start gap-2">
						<ShieldCheckIcon class="text-muted-foreground mt-0.5 size-5 shrink-0" />
						<div>
							<p class="text-foreground font-medium">Registrierung über individuelle Einladungscodes</p>
							<p class="text-xs opacity-90">
								Statische .env-Codes sind nicht aktiv oder nicht hinterlegt. Neue Konten können sich nur über die unten ausgestellten Einladungscodes registrieren.
							</p>
						</div>
					</div>
				</div>
			{/if}

			{#if frisch}
				<div class="border-primary/30 bg-primary/6 space-y-2 rounded-lg border p-3">
					<p class="text-sm">Neue Einladung – gilt genau einmal:</p>
					<p class="font-mono text-xl tracking-wider select-all">{frisch}</p>

					<!-- Der Link nimmt dem Empfaenger zwei Schritte ab: den Code abtippen
					     und die Adresse des Servers erfragen. -->
					<div class="flex flex-wrap items-center gap-2">
						<Button variant="outline" size="sm" onclick={() => linkKopieren(frisch)}>
							{#if linkKopiert}
								<CheckIcon class="size-4" /> Link kopiert
							{:else}
								<LinkIcon class="size-4" /> Einladungslink kopieren
							{/if}
						</Button>
						<Button variant="ghost" size="sm" onclick={() => codeKopieren(frisch)}>
							{#if codeKopiert}
								<CheckIcon class="size-4" /> Code kopiert
							{:else}
								<CopyIcon class="size-4" /> Nur den Code
							{/if}
						</Button>
					</div>

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
							<div
								class="flex flex-wrap items-center justify-between gap-2 border-b py-2 text-sm last:border-0"
							>
								<div class="min-w-0">
									<span class="font-mono">{i.code}</span>
									{#if i.note}
										<span class="text-muted-foreground truncate"> · {i.note}</span>
									{/if}
								</div>
								<div class="flex shrink-0 items-center gap-2">
									<Badge
										variant={s.offen ? "outline" : "secondary"}
										class={s.offen
											? "border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
											: ""}
									>
										{s.text}
									</Badge>
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
