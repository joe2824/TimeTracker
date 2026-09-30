<script lang="ts">
	import { onDestroy } from "svelte";
	import * as Card from "$lib/components/ui/card";
	import * as Dialog from "$lib/components/ui/dialog";
	import ConfirmDialog from "$lib/components/shared/ConfirmDialog.svelte";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Badge } from "$lib/components/ui/badge";
	import PairingCode from "$lib/components/onboarding/PairingCode.svelte";
	import { PairingFlow, suggestDeviceName } from "$lib/account/pairingFlow.svelte";
	import { toast } from "svelte-sonner";
	import { account } from "$lib/sync/account.svelte";
	import { ACCOUNT_KEY, invalidate, warm } from "$lib/ui/prefetch";
	import { formatPairingCode, isPairingCode, normalizePairingCode } from "$lib/crypto/vault";
	import { fmtDateHuman } from "$lib/time/time";
	import { isTauri } from "$lib/platform/env";
	import { initialServerUrl, rememberServerUrl } from "$lib/account/serverUrl";
	import { RELEASES_URL } from "$lib/platform/os";
	import { userErrorText } from "$lib/log";
	import { createLink } from "$lib/account/invite";
	import { openExternal } from "$lib/platform/open";
	import { pairStartLink } from "$lib/platform/deeplink";
	import CloudIcon from "@lucide/svelte/icons/cloud";
	import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
	import LaptopIcon from "@lucide/svelte/icons/laptop";
	import ClipboardPasteIcon from "@lucide/svelte/icons/clipboard-paste";
	import PlusIcon from "@lucide/svelte/icons/plus";
	import SmartphoneIcon from "@lucide/svelte/icons/smartphone";
	import { Skeleton } from "$lib/components/ui/skeleton";

	let serverUrl = $state(initialServerUrl(account.serverUrl));

	$effect(() => {
		if (serverUrl && typeof localStorage !== "undefined") {
			rememberServerUrl(serverUrl);
		}
	});
	let remotePairingCode = $state("");
	let addDeviceOpen = $state(false);
	let isPhraseRecoveryOpen = $state(false);
	let phraseRecoveryInput = $state("");
	let isLoading = $state(false);

	const pairing = new PairingFlow({
		done: () => toast.success("Gerät verknüpft – der erste Abgleich läuft."),
		failed: (e) => toast.error(userErrorText(e, "Kopplung fehlgeschlagen"))
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
				userErrorText(e, openBrowser ? "Konnte nicht beginnen" : "Kopplung nicht möglich")
			);
		} finally {
			isLoading = false;
		}
	}

	/**
	 * Die Anwendung auf diesem Rechner bitten, selbst eine Kopplung zu beginnen.
	 *
	 * Nimmt nur den Weg dorthin ab - den Code erzeugt sie und er wird von Hand
	 * herübergetragen, weil genau das die Prüfung ist.
	 */
	async function openAppForPairing() {
		try {
			await openExternal(pairStartLink(account.serverUrl));
		} catch (e) {
			toast.error(userErrorText(e, "Anwendung konnte nicht geöffnet werden"));
		}
	}

	/**
	 * Den Code aus der Zwischenablage holen.
	 *
	 * In diese Richtung geht kein Link: `timetracker://` fuehrt ZUR App, nicht
	 * zurueck in den Browser. Wer den Code drueben kopiert hat, soll ihn hier
	 * wenigstens nicht abtippen muessen.
	 */
	async function pastePairingCode() {
		try {
			const text = await navigator.clipboard.readText();
			const code = normalizePairingCode(text);
			if (!isPairingCode(code)) {
				toast.error("In der Zwischenablage steht kein Kopplungscode.");
				return;
			}
			remotePairingCode = formatPairingCode(code);
		} catch {
			// Ohne Freigabe fuer die Zwischenablage bleibt das Feld - Tippen geht ja.
			toast.error("Zwischenablage nicht lesbar. Bitte den Code eintragen.");
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
			void loadDevices(true);
		} catch (e) {
			toast.error(userErrorText(e, "Code konnte nicht bestätigt werden"));
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
			// Inzwischen getrennt: die Antwort gehört zum alten Konto.
			if (!account.linked) return;
			devices = info ? info.devices.filter((d) => !d.revokedAt) : [];
		} catch (e) {
			toast.error(userErrorText(e, "Geräte nicht abrufbar"));
		} finally {
			if (account.linked) isDevicesLoaded = true;
		}
	}

	$effect(() => {
		if (!account.linked) {
			// Nach einer neuen Verknüpfung die Liste frisch holen, nicht die alte zeigen.
			isDevicesLoaded = false;
			devices = [];
			invalidate(ACCOUNT_KEY);
			return;
		}
		if (!isDevicesLoaded) void loadDevices();
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
			toast.error(userErrorText(e, "Trennen fehlgeschlagen"));
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
			toast.error(userErrorText(e, "Zurückholen fehlgeschlagen"));
		} finally {
			isLoading = false;
		}
	}
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
					<!-- Im Browser ist die Serveradresse die eigene: sie als Ziel zu nennen,
					     wo man ohnehin steht, sagt nichts. Dort zaehlt, was der Abgleich tut;
					     in der Desktop-Anwendung ist die Adresse dagegen die Auskunft, wohin
					     die Daten gehen. -->
					{#if account.linked}
						{#if isTauri() && account.serverUrl}
							<p class="text-muted-foreground truncate text-xs font-mono mt-0.5">
								{account.serverUrl}
							</p>
						{:else}
							<p class="text-muted-foreground text-xs mt-0.5">
								Deine Zeiten liegen verschlüsselt auf diesem Server.
							</p>
						{/if}
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

			<!-- Nur ein Knopf: das Verbinden eines Geraets ist selten, ein dauerhaft
			     offenes Formular dafuer verschenkt den Platz. Alles Weitere im Dialog. -->
			<div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3.5">
				<div class="min-w-0">
					<p class="text-sm font-medium text-foreground">Weiteres Gerät verbinden</p>
					<p class="text-muted-foreground mt-0.5 text-xs">
						Ein zweiter PC oder ein anderer Browser bekommt dieselben Zeiten.
					</p>
				</div>
				<Button variant="outline" class="shrink-0 gap-2" onclick={() => (addDeviceOpen = true)}>
					<PlusIcon class="size-4" />
					Gerät verbinden
				</Button>
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

<ConfirmDialog
	open={deviceToDisconnect !== null}
	title={`„${deviceToDisconnect?.label}" trennen?`}
	description="Das Gerät kommt danach nicht mehr an dieses Konto. Was dort erfasst wurde, bleibt auf diesem Gerät und beim Server – nur der Zugang ist weg. Zurück geht es über eine neue Kopplung."
	confirmLabel="Trennen"
	onConfirm={handleConfirmDisconnect}
	onClose={() => (deviceToDisconnect = null)}
/>

<Dialog.Root bind:open={addDeviceOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Gerät verbinden</Dialog.Title>
			<Dialog.Description>
				Das andere Gerät zeigt einen Kopplungscode. Den trägst du hier ein.
			</Dialog.Description>
		</Dialog.Header>

		{#if !isTauri()}
			<!-- Der Link spart den Gang durch die Einstellungen der App; der Code
			     kommt trotzdem von Hand herüber - genau das ist die Prüfung. -->
			<div class="space-y-1.5">
				<Button variant="outline" class="w-full gap-2" onclick={openAppForPairing}>
					<LaptopIcon class="size-4" />
					App auf diesem PC öffnen
				</Button>
				<p class="text-muted-foreground text-xs">
					Noch nicht installiert?
					<a
						href={RELEASES_URL}
						target="_blank"
						rel="noreferrer noopener"
						class="underline underline-offset-2 hover:text-foreground"
					>
						Für Windows herunterladen
					</a>
				</p>
			</div>

			<div class="flex items-center gap-3">
				<span class="bg-border h-px flex-1"></span>
				<span class="text-muted-foreground text-xs">oder ein anderes Gerät</span>
				<span class="bg-border h-px flex-1"></span>
			</div>
		{/if}

		<div class="space-y-2">
			<Label for="fremdcode" class="text-muted-foreground text-xs font-normal">
				Dort unter <strong class="font-medium">Einstellungen → Konto → „Kopplungscode
				anzeigen“</strong>.
			</Label>
			<div class="flex items-center gap-2">
				<Input
					id="fremdcode"
					bind:value={remotePairingCode}
					placeholder="ABCD-EFGH-JKLM"
					maxlength={14}
					class="bg-background min-w-0 flex-1 font-mono tracking-wider uppercase"
					onkeydown={(e) => e.key === "Enter" && remotePairingCode.trim() && !isLoading && handleApprovePairing()}
				/>
				<Button
					variant="outline"
					size="icon"
					title="Aus der Zwischenablage einfügen"
					aria-label="Aus der Zwischenablage einfügen"
					onclick={pastePairingCode}
					disabled={isLoading}
				>
					<ClipboardPasteIcon class="size-4" />
				</Button>
			</div>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (addDeviceOpen = false)}>Abbrechen</Button>
			<Button onclick={handleApprovePairing} disabled={isLoading || !remotePairingCode.trim()}>
				{isLoading ? "Wird autorisiert…" : "Freigeben"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
