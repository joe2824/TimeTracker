<script lang="ts">
	import { onDestroy } from "svelte";
	import * as Card from "$lib/components/ui/card";
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Checkbox } from "$lib/components/ui/checkbox";
	import { Badge } from "$lib/components/ui/badge";
	import PairingCode from "$lib/components/onboarding/PairingCode.svelte";
	import { PairingFlow, suggestDeviceName } from "$lib/pairingFlow.svelte";
	import { toast } from "svelte-sonner";
	import { account } from "$lib/sync/account.svelte";
	import { ACCOUNT_KEY, invalidate, warm } from "$lib/prefetch";
	import { ApiError } from "$lib/sync/api";
	import { app } from "$lib/app.svelte";
	import { isPairingCode, normalizePairingCode } from "$lib/crypto/vault";
	import { fmtDateHuman } from "$lib/time";
	import { isTauri } from "$lib/platform/env";
	import { errorText } from "$lib/log";
	import { DEFAULT_SERVER } from "$lib/defaults";
	import { createLink } from "$lib/invite";
	import { openExternal } from "$lib/platform/open";
	import CloudIcon from "@lucide/svelte/icons/cloud";
	import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
	import LaptopIcon from "@lucide/svelte/icons/laptop";
	import SmartphoneIcon from "@lucide/svelte/icons/smartphone";
	import ShieldAlertIcon from "@lucide/svelte/icons/shield-alert";
	import { Skeleton } from "$lib/components/ui/skeleton";

	const formatError = (e: unknown, fallback: string) =>
		e instanceof Error ? errorText(e) : fallback;

	let serverUrl = $state(
		account.serverUrl ||
			(typeof localStorage !== "undefined" ? localStorage.getItem("tt_server_url") || "" : "") ||
			DEFAULT_SERVER ||
			""
	);

	$effect(() => {
		if (serverUrl && typeof localStorage !== "undefined") {
			localStorage.setItem("tt_server_url", serverUrl);
		}
	});
	let remotePairingCode = $state("");
	let inviteCode = $state("");
	let recoveryPhrase = $state("");
	let isPhraseRecoveryOpen = $state(false);
	let phraseRecoveryInput = $state("");
	let isPhraseConfirmed = $state(false);
	let isLoading = $state(false);

	const pairing = new PairingFlow({
		done: () => toast.success("Gerät verknüpft – der erste Abgleich läuft."),
		failed: (e) => toast.error(formatError(e, "Kopplung fehlgeschlagen"))
	});
	// Sonst sieht der Timer weiter nach, wenn dieser Bereich verschwindet.
	onDestroy(() => pairing.stop());

	const connectionStatus = $derived.by(() => {
		if (account.state === "off")
			return { text: "Nicht verknüpft", dot: "bg-muted-foreground" };
		if (account.state === "connecting") return { text: "Verbinde…", dot: "bg-muted-foreground" };
		if (account.state === "error") return { text: "Getrennt", dot: "bg-destructive" };
		if (account.phase === "offline") return { text: "Server nicht erreichbar", dot: "bg-amber-500" };
		if (account.phase === "error") return { text: "Server nicht erreichbar", dot: "bg-destructive" };
		if (account.phase === "running") {
			if (account.syncProgress && account.syncProgress.pulled > 0) {
				return { text: `Lade Daten… (${account.syncProgress.pulled})`, dot: "bg-blue-500" };
			}
			if (account.syncProgress && account.syncProgress.pushed > 0) {
				return { text: `Sende Daten… (${account.syncProgress.pushed})`, dot: "bg-blue-500" };
			}
			return { text: "Gleicht ab…", dot: "bg-emerald-500" };
		}
		return { text: "Verbunden", dot: "bg-emerald-500" };
	});

	/** `openBrowser`: erst das Konto im Browser anlegen, dann hier bestätigen. */
	async function beginPairing(openBrowser: boolean) {
		const url = serverUrl.trim();
		if (!url) {
			toast.error("Bitte die Adresse des Servers angeben.");
			return;
		}
		isLoading = true;
		try {
			await pairing.start(url);
			if (openBrowser) await openExternal(createLink(url));
		} catch (e) {
			toast.error(
				formatError(e, openBrowser ? "Konnte nicht beginnen" : "Kopplung nicht möglich")
			);
		} finally {
			isLoading = false;
		}
	}

	async function handleApprovePairing() {
		const normalized = normalizePairingCode(remotePairingCode);
		if (!isPairingCode(normalized)) {
			toast.error("Ein Kopplungscode hat zwölf Zeichen.");
			return;
		}
		isLoading = true;
		try {
			const label = await account.approvePairing(normalized);
			remotePairingCode = "";
			toast.success(`„${label}" ist jetzt verknüpft.`);
		} catch (e) {
			toast.error(formatError(e, "Code konnte nicht bestätigt werden"));
		} finally {
			isLoading = false;
		}
	}

	// ---------- Devices ----------

	type DeviceItem = { id: string; label: string; lastSeenAt: number | null; revokedAt: number | null };
	let devices = $state<DeviceItem[]>([]);
	let isDevicesLoaded = $state(false);

	async function loadDevices(fresh = false) {
		try {
			if (fresh) invalidate(ACCOUNT_KEY);
			const info = await warm(ACCOUNT_KEY, () => account.accountInfo());
			devices = info ? info.devices.filter((d) => !d.revokedAt) : [];
		} catch (e) {
			toast.error(formatError(e, "Geräte nicht abrufbar"));
		} finally {
			isDevicesLoaded = true;
		}
	}

	$effect(() => {
		if (account.linked && !isDevicesLoaded) void loadDevices();
	});

	let deviceToDisconnect = $state<DeviceItem | null>(null);

	async function handleConfirmDisconnect() {
		const target = deviceToDisconnect;
		if (!target) return;
		try {
			await account.revokeDevice(target.id);
			deviceToDisconnect = null;
			await loadDevices(true);
			toast.success(`„${target.label}" ist getrennt.`);
		} catch (e) {
			toast.error(formatError(e, "Trennen fehlgeschlagen"));
		}
	}

	let isInviteOpen = $state(false);

	async function handleCreateAccount(code = "") {
		const url = serverUrl.trim();
		if (!url) {
			toast.error("Bitte die Adresse des Servers angeben.");
			return;
		}
		isLoading = true;
		try {
			recoveryPhrase = await account.createAccount(url, app.settings.senderName.trim(), suggestDeviceName(), {
				invite: code.trim() || undefined
			});
			inviteCode = "";
			isInviteOpen = false;
			isPhraseConfirmed = false;
		} catch (e) {
			if (e instanceof ApiError && e.status === 403) {
				if (code.trim()) toast.error("Dieser Einladungscode gilt nicht.");
				isInviteOpen = true;
				return;
			}
			toast.error(formatError(e, "Konto konnte nicht angelegt werden"));
		} finally {
			isLoading = false;
		}
	}

	async function handleRecoverWithPhrase() {
		const url = serverUrl.trim();
		if (!url) {
			toast.error("Bitte die Adresse des Servers angeben.");
			return;
		}
		isLoading = true;
		try {
			await account.recoverWithPhrase(url, phraseRecoveryInput, suggestDeviceName());
			isPhraseRecoveryOpen = false;
			phraseRecoveryInput = "";
			toast.success("Konto zurückgeholt. Die Daten kommen jetzt vom Server.");
		} catch (e) {
			toast.error(formatError(e, "Zurückholen fehlgeschlagen"));
		} finally {
			isLoading = false;
		}
	}

	// Ein Code aus einem Link landet nur im Feld, er wird nicht durchgewunken.
	// Wer den Link geschickt hat, muss nicht der sein, dem der Rechner gehoert:
	// ein untergeschobenes `?pair=` verpackte sonst still den Vault-Schluessel
	// fuer ein fremdes Geraet. Bestaetigt wird von Hand, nach dem Blick auf den
	// Bildschirm des Rechners, der wirklich dazusoll.
	$effect(() => {
		if (!account.pairCodeFromLink) return;
		remotePairingCode = account.pairCodeFromLink;
		account.pairCodeFromLink = "";
	});

</script>

<Card.Root>
	<Card.Header>
		<div class="flex items-center gap-2">
			<CloudIcon class="size-5 text-primary shrink-0" />
			<Card.Title>Synchronisation & Geräte</Card.Title>
		</div>
		<Card.Description>
			{#if account.linked}
				Ende-zu-Ende verschlüsselte Synchronisation mit deinem Server.
			{:else}
				Optional. Ohne verknüpftes Konto bleibt alles auf diesem Rechner.
			{/if}
		</Card.Description>
	</Card.Header>

	<Card.Content class="space-y-4">
		{#if recoveryPhrase}
			<div class="border-primary/40 space-y-3 rounded-lg border bg-primary/5 p-4">
				<div>
					<p class="font-medium">Deine Wiederherstellungs-Phrase</p>
					<p class="text-muted-foreground text-sm">
						Wird genau einmal gezeigt. Solange kein Passkey und kein zweites Gerät da ist,
						sind diese Wörter der einzige Weg zu deinen Zeiten.
					</p>
				</div>

				<p class="bg-muted rounded-lg p-3 font-mono text-sm leading-relaxed select-all">
					{recoveryPhrase}
				</p>

				<Label for="phrase-gesichert" class="items-start gap-2.5 text-sm font-normal">
					<Checkbox id="phrase-gesichert" bind:checked={isPhraseConfirmed} class="mt-0.5" />
					<span>Ich habe die Phrase gesichert.</span>
				</Label>

				<Button
					disabled={!isPhraseConfirmed}
					onclick={() => {
						recoveryPhrase = "";
						inviteCode = "";
						toast.success("Konto angelegt. Deine Zeiten werden jetzt hochgeladen.");
					}}
				>
					Weiter
				</Button>
			</div>
		{/if}

		<!-- Status-Box -->
		<div class="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3.5 sm:flex-row sm:items-center sm:justify-between">
			<div class="flex items-center gap-3 min-w-0">
				<div class="relative flex size-3 shrink-0 items-center justify-center">
					{#if account.linked && (connectionStatus.text === "Verbunden" || connectionStatus.text === "Gleicht ab…")}
						<span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
					{/if}
					<span class="relative inline-flex size-2.5 rounded-full {connectionStatus.dot}"></span>
				</div>
				<div class="min-w-0">
					<div class="flex flex-wrap items-center gap-2">
						<span class="font-medium text-sm text-foreground">{connectionStatus.text}</span>
						{#if account.linked && account.pending > 0}
							<Badge variant="outline" class="text-xs font-normal">
								{account.pending} {account.pending === 1 ? "Änderung ausstehend" : "Änderungen ausstehend"}
							</Badge>
						{/if}
					</div>
					{#if account.linked && account.serverUrl}
						<p class="text-muted-foreground truncate text-xs font-mono mt-0.5">{account.serverUrl}</p>
					{/if}
				</div>
			</div>
			{#if account.linked}
				<Button
					variant="outline"
					size="sm"
					class="shrink-0 self-start sm:self-center gap-1.5"
					disabled={account.phase === "running"}
					onclick={() => account.syncNow()}
				>
					<RefreshCwIcon class="size-3.5 {account.phase === 'running' ? 'animate-spin' : ''}" />
					{account.phase === "running"
						? account.syncProgress?.pulled
							? `Lade (${account.syncProgress.pulled})…`
							: account.syncProgress?.pushed
								? `Sende (${account.syncProgress.pushed})…`
								: "Gleicht ab…"
						: "Jetzt abgleichen"}
				</Button>
			{:else if account.state === "error"}
				<Button
					variant="outline"
					size="sm"
					class="shrink-0 self-start sm:self-center text-xs text-destructive hover:bg-destructive/10"
					onclick={async () => {
						await account.unlink();
						toast.info("Verknüpfung zurückgesetzt.");
					}}
				>
					Verknüpfung zurücksetzen
				</Button>
			{/if}
		</div>

		{#if account.linked}
			{#if account.lostEdits > 0}
				<div class="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
					<ShieldAlertIcon class="size-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
					<p>
						{account.lostEdits} eigene {account.lostEdits === 1 ? "Änderung wurde" : "Änderungen wurden"} von einer neueren Fassung eines anderen Geräts überschrieben.
					</p>
				</div>
			{/if}

			{#if !isDevicesLoaded}
				<div class="space-y-2 pt-1">
					<Skeleton class="h-3 w-36" />
					<div class="divide-y rounded-lg border bg-card">
						{#each Array(2) as _}
							<div class="flex items-center justify-between p-3">
								<div class="flex items-center gap-3 min-w-0">
									<Skeleton class="size-8 rounded-md shrink-0" />
									<div class="space-y-1.5 min-w-0">
										<Skeleton class="h-4 w-32" />
										<Skeleton class="h-3 w-24" />
									</div>
								</div>
								<Skeleton class="h-8 w-16 rounded-md shrink-0" />
							</div>
						{/each}
					</div>
				</div>
			{:else if devices.length > 0}
				<div class="space-y-2 pt-1">
					<Label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
						Verknüpfte Geräte ({devices.length})
					</Label>
					<div class="divide-y rounded-lg border bg-card">
						{#each devices as item (item.id)}
							<div class="flex items-center justify-between gap-3 p-3 text-sm">
								<div class="flex items-center gap-3 min-w-0">
									<div class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
										{#if item.label.toLowerCase().includes("handy") || item.label.toLowerCase().includes("phone") || item.label.toLowerCase().includes("mobile")}
											<SmartphoneIcon class="size-4" />
										{:else}
											<LaptopIcon class="size-4" />
										{/if}
									</div>
									<div class="min-w-0">
										<div class="flex items-center gap-2">
											<p class="font-medium text-foreground truncate">{item.label}</p>
											{#if item.id === account.thisDeviceId}
												<Badge variant="secondary" class="text-[10px] px-1.5 py-0 h-4 font-normal">dieses Gerät</Badge>
											{/if}
										</div>
										<p class="text-muted-foreground text-xs">
											{item.lastSeenAt ? `Zuletzt aktiv: ${fmtDateHuman(item.lastSeenAt)}` : "Noch nie verbunden"}
										</p>
									</div>
								</div>
								{#if item.id !== account.thisDeviceId}
									<Button
										variant="ghost"
										size="sm"
										class="shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10 text-xs"
										onclick={() => (deviceToDisconnect = item)}
									>
										Trennen
									</Button>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<div class="space-y-3 rounded-lg border bg-muted/20 p-3.5">
				<div>
					<p class="font-medium text-sm text-foreground">Zweiten PC oder neues Gerät hinzufügen</p>
					<p class="text-muted-foreground text-xs mt-0.5">
						So verbindest du einen weiteren Rechner oder ein anderes Gerät mit diesem Konto:
					</p>
				</div>

				<div class="grid gap-2 text-xs text-muted-foreground bg-card/60 p-3 rounded-md border">
					<div class="flex items-start gap-2">
						<span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-semibold text-[11px]">1</span>
						<span>Installiere TimeTracker auf deinem <strong>zweiten PC</strong> (oder öffne die App dort).</span>
					</div>
					<div class="flex items-start gap-2">
						<span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-semibold text-[11px]">2</span>
						<span>Gehe auf dem zweiten PC auf <strong>Einstellungen → Konto</strong> und klicke auf <em>„Kopplungscode anzeigen“</em>.</span>
					</div>
					<div class="flex items-start gap-2">
						<span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-semibold text-[11px]">3</span>
						<span>Trage den dort angezeigten 12-stelligen Code hier ein:</span>
					</div>
				</div>

				<div class="flex flex-wrap items-center gap-2 pt-1">
					<Input
						id="fremdcode"
						bind:value={remotePairingCode}
						placeholder="ABCD-EFGH-JKLM"
						maxlength={14}
						class="w-52 font-mono tracking-wider uppercase bg-background"
						onkeydown={(e) => e.key === "Enter" && remotePairingCode.trim() && !isLoading && handleApprovePairing()}
					/>
					<Button onclick={handleApprovePairing} disabled={isLoading || !remotePairingCode.trim()}>
						{isLoading ? "Wird autorisiert…" : "Gerät freigeben"}
					</Button>
				</div>
			</div>
		{:else if pairing.waiting}
			<div class="border-t pt-3">
				<PairingCode code={pairing.code} onCancel={() => pairing.cancel()} />
			</div>
		{:else}
			<div class="space-y-2 border-t pt-3">
				<div class="space-y-1.5">
					<Label for="srv">Adresse des Servers</Label>
					<Input id="srv" bind:value={serverUrl} placeholder="https://tracker.example.de" />
				</div>

				<div class="space-y-2 pt-3">
					<Button disabled={isLoading || !serverUrl.trim()} onclick={() => beginPairing(true)}>
						{isLoading ? "Öffnet…" : "Konto anlegen und verknüpfen"}
					</Button>
					<p class="text-muted-foreground text-xs">
						Öffnet den Browser direkt beim Anlegen. Sobald das Konto steht, legt der
						Browser den Code von hier zum Bestätigen vor – abtippen musst du ihn nicht,
						nur mit dem Code unten vergleichen.
					</p>
				</div>

				<div class="space-y-2 border-t pt-3">
					<p class="text-sm font-medium">Mit bestehendem Konto verbinden</p>
					<Button variant="outline" onclick={() => beginPairing(false)} disabled={isLoading}>
						Kopplungscode anzeigen
					</Button>
					<p class="text-muted-foreground text-xs">
						Generiert einen Code, den du auf deinem bereits verknüpften Gerät eingibst.
					</p>
				</div>

				<div class="space-y-2 border-t pt-3">
					{#if !isPhraseRecoveryOpen}
						<Button variant="ghost" size="sm" onclick={() => (isPhraseRecoveryOpen = true)}>
							Mit Wiederherstellungs-Phrase zurückholen
						</Button>
						<p class="text-muted-foreground text-xs">
							Wenn kein Gerät mehr da ist, das bestätigen könnte.
						</p>
					{:else}
						<Label for="wphrase">Die 24 Wörter</Label>
						<textarea
							id="wphrase"
							bind:value={phraseRecoveryInput}
							rows="3"
							class="border-input bg-background w-full rounded-md border p-2 font-mono text-sm"
							placeholder="wort eins wort zwei wort drei …"
						></textarea>
						<div class="flex gap-2">
							<Button onclick={handleRecoverWithPhrase} disabled={isLoading}>
								{isLoading ? "Sucht…" : "Konto zurückholen"}
							</Button>
							<Button
								variant="ghost"
								disabled={isLoading}
								onclick={() => {
									isPhraseRecoveryOpen = false;
									phraseRecoveryInput = "";
								}}>Abbrechen</Button
							>
						</div>
						<p class="text-muted-foreground text-xs">
							Die Wörter verlassen dieses Gerät nicht. Der Server bekommt nur eine Kennung,
							aus der sich nichts zurückrechnen lässt.
						</p>
					{/if}
				</div>
			</div>
		{/if}
	</Card.Content>
</Card.Root>

<Dialog.Root open={deviceToDisconnect !== null} onOpenChange={(o) => !o && (deviceToDisconnect = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>„{deviceToDisconnect?.label}" trennen?</Dialog.Title>
			<Dialog.Description>
				Das Gerät kommt danach nicht mehr an dieses Konto. Was dort erfasst wurde, bleibt auf
				diesem Gerät und beim Server – nur der Zugang ist weg. Zurück geht es über eine neue
				Kopplung.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deviceToDisconnect = null)}>Abbrechen</Button>
			<Button variant="destructive" onclick={handleConfirmDisconnect}>Trennen</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={isInviteOpen} onOpenChange={(o) => (isInviteOpen = o)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Einladungscode</Dialog.Title>
			<Dialog.Description>
				Dieser Server nimmt keine offenen Registrierungen an.
			</Dialog.Description>
		</Dialog.Header>
		<Input
			bind:value={inviteCode}
			placeholder="ABCD-EFGH-JKLM-NPQR"
			class="font-mono tracking-wider uppercase"
			onkeydown={(e) => e.key === "Enter" && handleCreateAccount(inviteCode)}
		/>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (isInviteOpen = false)}>Abbrechen</Button>
			<Button disabled={isLoading || !inviteCode.trim()} onclick={() => handleCreateAccount(inviteCode)}>
				{isLoading ? "Legt an…" : "Konto anlegen"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
