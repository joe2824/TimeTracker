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
	import UserPlusIcon from "@lucide/svelte/icons/user-plus";
	import BanIcon from "@lucide/svelte/icons/ban";
	import GlobeIcon from "@lucide/svelte/icons/globe";
	import LockIcon from "@lucide/svelte/icons/lock";

	let liste = $state<Invite[]>([]);
	let geladen = $state(false);
	let laeuft = $state(false);
	let envConfigured = $state(false);
	let envActive = $state(true);
	let envLaeuft = $state(false);
	let openRegistration = $state(false);
	let openLaeuft = $state(false);
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
			openRegistration = res.openRegistration;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Einladungen nicht abrufbar");
		} finally {
			geladen = true;
		}
	}

	$effect(() => {
		if (account.isAdmin && !geladen) void laden();
	});

	async function toggleOpenRegistration() {
		openLaeuft = true;
		const ziel = !openRegistration;
		try {
			openRegistration = await account.setOpenRegistration(ziel);
			if (openRegistration) {
				toast.success("Offene Registrierung aktiviert. Jeder kann sich jetzt ohne Einladungscode registrieren.");
			} else {
				toast.success("Offene Registrierung deaktiviert. Neue Konten brauchen wieder einen Einladungscode.");
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Änderung fehlgeschlagen");
		} finally {
			openLaeuft = false;
		}
	}

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
	function stand(i: Invite): { text: string; offen: boolean; badgeClass: string } {
		if (i.usedAt) {
			return {
				text: `Genutzt ${fmtDateHuman(i.usedAt)}`,
				offen: false,
				badgeClass: "bg-muted text-muted-foreground"
			};
		}
		if (i.revokedAt) {
			return {
				text: "Zurückgezogen",
				offen: false,
				badgeClass: "border-destructive/30 bg-destructive/10 text-destructive"
			};
		}
		if (i.expiresAt && i.expiresAt < Date.now()) {
			return {
				text: "Abgelaufen",
				offen: false,
				badgeClass: "border-muted-foreground/30 bg-muted text-muted-foreground"
			};
		}
		if (i.expiresAt) {
			return {
				text: `Gültig bis ${fmtDateHuman(i.expiresAt)}`,
				offen: true,
				badgeClass: "border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
			};
		}
		return {
			text: "Offen",
			offen: true,
			badgeClass: "border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
		};
	}

	const offen = $derived(
		liste.filter((i) => !i.usedAt && !i.revokedAt && (!i.expiresAt || i.expiresAt > Date.now()))
	);
</script>

{#if account.isAdmin}
	<Card.Root>
		<Card.Header>
			<div class="flex items-center gap-2">
				<ShieldCheckIcon class="size-5 text-primary shrink-0" />
				<Card.Title>Server-Verwaltung & Einladungen</Card.Title>
			</div>
			<Card.Description>
				Registrierungsrichtlinien und Einladungscodes verwalten. Zeiterfassungsdaten bleiben Ende-zu-Ende verschlüsselt.
			</Card.Description>
		</Card.Header>

		<Card.Content class="space-y-4">
			<!-- Haupt-Richtlinie: Offene Registrierung vs. Nur mit Einladung -->
			{#if openRegistration}
				<div class="border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200 flex flex-col gap-3 rounded-lg border p-3.5 text-sm sm:flex-row sm:items-center sm:justify-between">
					<div class="flex items-start gap-2.5">
						<GlobeIcon class="text-amber-600 dark:text-amber-400 mt-0.5 size-5 shrink-0" />
						<div>
							<p class="font-medium">Öffentliche Registrierung ist aktiv</p>
							<p class="text-xs opacity-90 leading-relaxed">
								Jede Person, die die Serveradresse kennt, kann sich direkt ohne Einladungscode registrieren.
							</p>
						</div>
					</div>
					<Button
						variant="outline"
						size="sm"
						class="shrink-0 self-start sm:self-center"
						onclick={toggleOpenRegistration}
						disabled={openLaeuft}
					>
						{openLaeuft ? "Wird umgestellt…" : "Einladungscode erzwingen"}
					</Button>
				</div>
			{:else}
				<div class="border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200 flex flex-col gap-3 rounded-lg border p-3.5 text-sm sm:flex-row sm:items-center sm:justify-between">
					<div class="flex items-start gap-2.5">
						<LockIcon class="text-emerald-600 dark:text-emerald-400 mt-0.5 size-5 shrink-0" />
						<div>
							<p class="font-medium">Registrierung nur mit Einladungscode</p>
							<p class="text-xs opacity-90 leading-relaxed">
								Geschlossener Server: Neue Konten können sich nur über gültige Einladungscodes registrieren.
							</p>
						</div>
					</div>
					<Button
						variant="outline"
						size="sm"
						class="shrink-0 self-start sm:self-center"
						onclick={toggleOpenRegistration}
						disabled={openLaeuft}
					>
						{openLaeuft ? "Wird umgestellt…" : "Offene Registrierung erlauben"}
					</Button>
				</div>
			{/if}

			{#if !openRegistration && envConfigured}
				{#if envActive}
					<div class="border-amber-500/30 bg-amber-500/5 text-amber-900 dark:text-amber-200 flex flex-col gap-2 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
						<div class="flex items-start gap-2.5">
							<ShieldAlertIcon class="text-amber-600 dark:text-amber-400 mt-0.5 size-4 shrink-0" />
							<div>
								<p class="font-medium text-xs">Statische .env-Codes sind aktiv</p>
								<p class="text-[11px] opacity-90 leading-relaxed">
									Der Server akzeptiert noch statische Codes aus der Konfiguration.
								</p>
							</div>
						</div>
						<Button
							variant="destructive"
							size="sm"
							class="h-7 text-xs shrink-0 self-start sm:self-center"
							onclick={toggleEnvInvites}
							disabled={envLaeuft}
						>
							{envLaeuft ? "Wird deaktiviert…" : "Codes deaktivieren"}
						</Button>
					</div>
				{:else}
					<div class="border-border/60 bg-muted/40 text-muted-foreground flex flex-col gap-2 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
						<div class="flex items-start gap-2.5">
							<ShieldCheckIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
							<div>
								<p class="text-foreground font-medium text-xs">Statische .env-Codes sind deaktiviert</p>
								<p class="text-[11px] opacity-90 leading-relaxed">
									Nur noch individuell ausgestellte Einladungscodes werden akzeptiert.
								</p>
							</div>
						</div>
						<Button
							variant="outline"
							size="sm"
							class="h-7 text-xs shrink-0 self-start sm:self-center"
							onclick={toggleEnvInvites}
							disabled={envLaeuft}
						>
							{envLaeuft ? "Wird aktiviert…" : "Wieder aktivieren"}
						</Button>
					</div>
				{/if}
			{/if}

			{#if frisch}
				<div class="border-primary/40 bg-primary/5 space-y-3 rounded-lg border p-4">
					<div>
						<p class="font-medium text-sm text-foreground">Neue Einladung erstellt – gilt genau einmal:</p>
						<p class="font-mono text-2xl tracking-wider select-all text-primary font-semibold mt-1">{frisch}</p>
					</div>

					<div class="flex flex-wrap items-center gap-2 pt-1">
						<Button variant="outline" size="sm" class="gap-1.5" onclick={() => linkKopieren(frisch)}>
							{#if linkKopiert}
								<CheckIcon class="size-4 text-emerald-500" /> Link kopiert
							{:else}
								<LinkIcon class="size-4" /> Einladungslink kopieren
							{/if}
						</Button>
						<Button variant="ghost" size="sm" class="gap-1.5" onclick={() => codeKopieren(frisch)}>
							{#if codeKopiert}
								<CheckIcon class="size-4 text-emerald-500" /> Code kopiert
							{:else}
								<CopyIcon class="size-4" /> Nur den Code
							{/if}
						</Button>
					</div>

					<p class="text-muted-foreground text-xs">
						Code oder Link an das Team-Mitglied weitergeben. Er erscheint auch unten in der Einladungsliste.
					</p>
				</div>
			{/if}

			<!-- Neue Einladung ausstellen -->
			<div class="space-y-3 rounded-lg border bg-muted/20 p-3.5">
				<div>
					<p class="font-medium text-sm text-foreground">Neue Einladung ausstellen</p>
					<p class="text-muted-foreground text-xs">
						Erzeugt einen einmalig gültigen Code zur Kontoerstellung.
					</p>
				</div>
				<div class="grid gap-2.5 sm:grid-cols-[1fr_auto]">
					<div class="space-y-1">
						<Label for="inote" class="text-xs">Notiz / Empfänger (optional)</Label>
						<Input
							id="inote"
							bind:value={notiz}
							placeholder="z. B. Kollegin Maxima"
							class="text-sm"
							onkeydown={(e) => e.key === "Enter" && !laeuft && ausstellen()}
						/>
					</div>
					<div class="space-y-1">
						<Label for="itage" class="text-xs">Gültig (Tage)</Label>
						<Input
							id="itage"
							bind:value={tage}
							type="number"
							min="1"
							placeholder="∞"
							class="w-28 text-sm"
							onkeydown={(e) => e.key === "Enter" && !laeuft && ausstellen()}
						/>
					</div>
				</div>
				<Button onclick={ausstellen} disabled={laeuft} class="gap-1.5">
					<UserPlusIcon class="size-4" />
					{laeuft ? "Stellt aus…" : "Einladung ausstellen"}
				</Button>
			</div>

			<!-- Liste der Einladungen -->
			<div class="space-y-2 pt-1">
				<div class="flex items-center justify-between">
					<Label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
						Ausgestellte Einladungen ({liste.length})
						{#if offen.length > 0}
							<span class="text-emerald-600 dark:text-emerald-400 font-normal"> · {offen.length} offen</span>
						{/if}
					</Label>
				</div>

				{#if !geladen}
					<p class="text-muted-foreground text-sm">Lädt…</p>
				{:else if liste.length === 0}
					<div class="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
						Noch keine Einladungen ausgestellt.
					</div>
				{:else}
					<div class="divide-y rounded-lg border bg-card">
						{#each liste as i (i.code)}
							{@const s = stand(i)}
							<div class="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
								<div class="min-w-0">
									<div class="flex items-center gap-2">
										<span class="font-mono font-medium tracking-wide text-foreground">{i.code}</span>
										{#if i.note}
											<span class="text-muted-foreground truncate text-xs">· {i.note}</span>
										{/if}
									</div>
								</div>
								<div class="flex shrink-0 items-center gap-2">
									<Badge variant="outline" class="text-[10px] px-2 py-0.5 font-normal {s.badgeClass}">
										{s.text}
									</Badge>
									{#if !i.usedAt && !i.revokedAt}
										<Button
											variant="ghost"
											size="icon-sm"
											class="text-muted-foreground hover:text-foreground"
											title="Einladungslink kopieren"
											onclick={() => linkKopieren(i.code)}
										>
											<LinkIcon class="size-3.5" />
										</Button>
										<Button
											variant="ghost"
											size="sm"
											class="text-muted-foreground hover:text-destructive hover:bg-destructive/10 text-xs gap-1"
											onclick={() => zurueckziehen(i.code)}
										>
											<BanIcon class="size-3.5" />
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
