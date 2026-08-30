<script lang="ts">
	import * as Card from "$lib/components/ui/card";
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Checkbox } from "$lib/components/ui/checkbox";
	import { Badge } from "$lib/components/ui/badge";
	import SettingRow from "$lib/components/SettingRow.svelte";
	import PairingCode from "$lib/components/PairingCode.svelte";
	import { toast } from "svelte-sonner";
	import { account } from "$lib/sync/account.svelte";
	import { ApiError } from "$lib/sync/api";
	import { app } from "$lib/app.svelte";
	import { isPairingCode, normalizePairingCode } from "$lib/crypto/vault";
	import { fmtDateHuman } from "$lib/time";
	import { capabilities } from "$lib/platform/env";
	import { errorText } from "$lib/log";
	import { DEFAULT_SERVER } from "$lib/defaults";
	import { anlegenLink } from "$lib/invite";
	import { openExternal } from "$lib/platform/open";
	import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
	import CloudIcon from "@lucide/svelte/icons/cloud";
	import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
	import LaptopIcon from "@lucide/svelte/icons/laptop";
	import SmartphoneIcon from "@lucide/svelte/icons/smartphone";
	import ShieldAlertIcon from "@lucide/svelte/icons/shield-alert";

	/** Text zu einem geworfenen Wert, sonst der eigene Standard. */
	const fehlertext = (e: unknown, standard: string) =>
		e instanceof Error ? errorText(e) : standard;

	// Steht beim Bauen ein Server fest, ist er die Vorgabe - sonst bleibt das Feld
	// leer wie bisher.
	let serverUrl = $state(DEFAULT_SERVER);
	/** Hat jemand die Vorgabe ausdruecklich verlassen? */
	let eigenerServer = $state(false);
	let code = $state("");
	let fremderCode = $state("");
	let einladung = $state("");
	/** Die Phrase, genau einmal - danach nie wieder. */
	let phrase = $state("");
	let phraseEingabeOffen = $state(false);
	let phraseEingabe = $state("");
	let phraseBestaetigt = $state(false);
	let laeuft = $state(false);
	/** Warten auf die Bestaetigung des anderen Geraets. */
	let warten = $state(false);
	let poll: ReturnType<typeof setInterval> | null = null;

	/** Status als Punkt + kurzer Text. */
	const zustand = $derived.by(() => {
		if (account.state === "aus")
			return { text: "Nicht verknüpft", punkt: "bg-muted-foreground" };
		if (account.state === "verbindet") return { text: "Verbinde…", punkt: "bg-muted-foreground" };
		if (account.state === "fehler") return { text: "Getrennt", punkt: "bg-destructive" };
		if (account.phase === "offline") return { text: "Server nicht erreichbar", punkt: "bg-amber-500" };
		if (account.phase === "fehler") return { text: "Server nicht erreichbar", punkt: "bg-destructive" };
		if (account.phase === "laeuft") return { text: "Gleicht ab…", punkt: "bg-emerald-500" };
		return { text: "Verbunden", punkt: "bg-emerald-500" };
	});

	let nameInput = $state(account.name || app.settings.senderName || "");
	let isSavingName = $state(false);

	$effect(() => {
		if (account.name && nameInput !== account.name && !isSavingName) {
			nameInput = account.name;
		}
	});

	async function saveName() {
		const trimmed = nameInput.trim();
		if (!trimmed || trimmed === account.name) return;
		isSavingName = true;
		try {
			await account.updateDisplayName(trimmed);
			toast.success("Anzeigename aktualisiert.");
		} catch (e) {
			toast.error("Name konnte nicht aktualisiert werden.");
		} finally {
			isSavingName = false;
		}
	}

	function vorschlagName(): string {
		// Ein Name, den man in der Geraeteliste wiedererkennt, ohne ihn zu tippen.
		const p = navigator.platform || "Gerät";
		return capabilities.tray ? `Rechner (${p})` : `Browser (${p})`;
	}

	/**
	 * Kopplungscode holen und den Browser oeffnen. Der Code bleibt HIER auf dem
	 * Bildschirm stehen und wird drueben abgetippt - im Link haette er in der
	 * Chronik gestanden, und der Vergleich waere zur Formsache geworden.
	 */
	async function losgehen() {
		const url = serverUrl.trim();
		if (!url) {
			toast.error("Bitte die Adresse des Servers angeben.");
			return;
		}
		laeuft = true;
		try {
			code = await account.startPairing(url, vorschlagName());
			warten = true;
			poll = setInterval(pruefen, 2000);
			await openExternal(anlegenLink(url));
		} catch (e) {
			toast.error(fehlertext(e, "Konnte nicht beginnen"));
		} finally {
			laeuft = false;
		}
	}

	async function koppelnStarten() {
		const url = serverUrl.trim();
		if (!url) {
			toast.error("Bitte die Adresse des Servers angeben.");
			return;
		}
		laeuft = true;
		try {
			code = await account.startPairing(url, vorschlagName());
			warten = true;
			// Nachsehen, ob jemand bestaetigt hat. Kein Kanal: der Vorgang dauert
			// Sekunden, und jemand sieht dabei zu.
			poll = setInterval(pruefen, 2000);
		} catch (e) {
			toast.error(fehlertext(e, "Kopplung nicht möglich"));
		} finally {
			laeuft = false;
		}
	}

	async function pruefen() {
		try {
			if (await account.checkPairing()) {
				abbrechen();
				toast.success("Gerät verknüpft – der erste Abgleich läuft.");
			}
		} catch (e) {
			abbrechen();
			toast.error(fehlertext(e, "Kopplung fehlgeschlagen"));
		}
	}

	function abbrechen() {
		if (poll) clearInterval(poll);
		poll = null;
		warten = false;
		code = "";
		account.cancelPairing();
	}

	async function bestaetigen() {
		// Bindestriche und Leerzeichen fallen weg: der Code wird angezeigt wie
		// "ABCD-EFGH-JKLM", und wer ihn so abtippt, soll nicht scheitern.
		const c = normalizePairingCode(fremderCode);
		if (!isPairingCode(c)) {
			toast.error("Ein Kopplungscode hat zwölf Zeichen.");
			return;
		}
		laeuft = true;
		try {
			const label = await account.approvePairing(c);
			fremderCode = "";
			toast.success(`„${label}" ist jetzt verknüpft.`);
		} catch (e) {
			toast.error(fehlertext(e, "Code konnte nicht bestätigt werden"));
		} finally {
			laeuft = false;
		}
	}

	// ---------- Verknuepfte Geraete ----------

	type Geraet = { id: string; label: string; lastSeenAt: number | null; revokedAt: number | null };
	let geraete = $state<Geraet[]>([]);
	let geraeteGeladen = $state(false);

	async function geraeteLaden() {
		try {
			const info = await account.accountInfo();
			geraete = info ? info.devices.filter((d) => !d.revokedAt) : [];
		} catch (e) {
			toast.error(fehlertext(e, "Geräte nicht abrufbar"));
		} finally {
			geraeteGeladen = true;
		}
	}

	$effect(() => {
		if (account.linked && !geraeteGeladen) void geraeteLaden();
	});

	/** Welches Geraet soll weg? Gesetzt heisst: die Rueckfrage steht offen. */
	let trenntGeraet = $state<Geraet | null>(null);

	async function trennenBestaetigt() {
		const g = trenntGeraet;
		if (!g) return;
		try {
			await account.revokeDevice(g.id);
			trenntGeraet = null;
			await geraeteLaden();
			toast.success(`„${g.label}" ist getrennt.`);
		} catch (e) {
			toast.error(fehlertext(e, "Trennen fehlgeschlagen"));
		}
	}

	/** Steht die Frage nach dem Einladungscode offen? */
	let inviteOffen = $state(false);

	/** Ein Konto von hier aus anlegen - Code erst, wenn der Server ihn verlangt. */
	async function kontoAnlegen(code = "") {
		const url = serverUrl.trim();
		if (!url) {
			toast.error("Bitte die Adresse des Servers angeben.");
			return;
		}
		laeuft = true;
		try {
			// Der Name aus dem Willkommensbildschirm, falls jemand einen eingetragen
			// hat - ein zweites Feld dafuer waere dieselbe Frage ein zweites Mal.
			// Leer ist erlaubt: dann setzt der Server die Kontokennung ein.
			phrase = await account.createAccount(url, app.settings.senderName.trim(), vorschlagName(), {
				invite: code.trim() || undefined
			});
			einladung = "";
			inviteOffen = false;
			phraseBestaetigt = false;
		} catch (e) {
			if (e instanceof ApiError && e.status === 403) {
				// Beim ersten Mal ist das keine Fehlermeldung, sondern eine Frage.
				if (code.trim()) toast.error("Dieser Einladungscode gilt nicht.");
				inviteOffen = true;
				return;
			}
			toast.error(fehlertext(e, "Konto konnte nicht angelegt werden"));
		} finally {
			laeuft = false;
		}
	}

	/** Das Konto allein mit den 24 Woertern zurueckholen. */
	async function zurueckholen() {
		const url = serverUrl.trim();
		if (!url) {
			toast.error("Bitte die Adresse des Servers angeben.");
			return;
		}
		laeuft = true;
		try {
			await account.recoverWithPhrase(url, phraseEingabe, vorschlagName());
			phraseEingabeOffen = false;
			phraseEingabe = "";
			toast.success("Konto zurückgeholt. Die Daten kommen jetzt vom Server.");
		} catch (e) {
			toast.error(fehlertext(e, "Zurückholen fehlgeschlagen"));
		} finally {
			laeuft = false;
		}
	}

	// Kam ein Code ueber einen Link herein, gehoert er ins Feld - und danach weg,
	// damit er beim naechsten Aufbau der Karte nicht wieder auftaucht.
	$effect(() => {
		if (!account.pairCodeFromLink) return;
		fremderCode = account.pairCodeFromLink;
		account.pairCodeFromLink = "";
	});

	$effect(() => () => {
		if (poll) clearInterval(poll);
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
		{#if phrase}
			<!-- Kein Wegklick-Button, sondern ein Haekchen: ohne zweites Geraet oder
			     Passkey sind diese 24 Woerter der einzige Weg zu den Daten - auch der
			     Betreiber kann nichts entschluesseln. -->
			<div class="border-primary/40 space-y-3 rounded-lg border bg-primary/5 p-4">
				<div>
					<p class="font-medium">Deine Wiederherstellungs-Phrase</p>
					<p class="text-muted-foreground text-sm">
						Wird genau einmal gezeigt. Solange kein Passkey und kein zweites Gerät da ist,
						sind diese Wörter der einzige Weg zu deinen Zeiten.
					</p>
				</div>

				<p class="bg-muted rounded-lg p-3 font-mono text-sm leading-relaxed select-all">
					{phrase}
				</p>

				<Label for="phrase-gesichert" class="items-start gap-2.5 text-sm font-normal">
					<Checkbox id="phrase-gesichert" bind:checked={phraseBestaetigt} class="mt-0.5" />
					<span>Ich habe die Phrase gesichert.</span>
				</Label>

				<Button
					disabled={!phraseBestaetigt}
					onclick={() => {
						phrase = "";
						einladung = "";
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
					{#if account.linked && (zustand.text === "Verbunden" || zustand.text === "Gleicht ab…")}
						<span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
					{/if}
					<span class="relative inline-flex size-2.5 rounded-full {zustand.punkt}"></span>
				</div>
				<div class="min-w-0">
					<div class="flex flex-wrap items-center gap-2">
						<span class="font-medium text-sm text-foreground">{zustand.text}</span>
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
					disabled={account.phase === "laeuft"}
					onclick={() => account.syncNow()}
				>
					<RefreshCwIcon class="size-3.5 {account.phase === 'laeuft' ? 'animate-spin' : ''}" />
					{account.phase === "laeuft" ? "Gleicht ab…" : "Jetzt abgleichen"}
				</Button>
			{/if}
		</div>

		{#if account.linked}
			<!-- Profil: Anzeigename -->
			<div class="rounded-lg border bg-muted/20 p-3.5 space-y-3">
				<div>
					<p class="font-medium text-sm text-foreground">Benutzerprofil</p>
					<p class="text-muted-foreground text-xs">
						Dein Anzeigename auf dem Server und in der Benutzerliste.
					</p>
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<div class="space-y-1 flex-1 min-w-[200px]">
						<Label for="accname" class="text-xs">Anzeigename</Label>
						<Input
							id="accname"
							bind:value={nameInput}
							placeholder="z. B. Max Mustermann"
							class="text-sm"
							onkeydown={(e) => e.key === "Enter" && saveName()}
							onblur={saveName}
						/>
					</div>
					<Button
						variant="outline"
						size="sm"
						class="self-end h-9"
						onclick={saveName}
						disabled={isSavingName}
					>
						{isSavingName ? "Speichert…" : "Speichern"}
					</Button>
				</div>
			</div>

			{#if !account.secretsProtected}
				<div class="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
					<ShieldAlertIcon class="size-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
					<div>
						<p class="font-medium">Lokale Schlüsselablage nicht geschützt</p>
						<p class="mt-0.5 opacity-90 leading-relaxed">
							Schlüssel und Zugang liegen ungeschützt im Datenordner – das Betriebssystem bietet hier keine geschützte Ablage.
						</p>
					</div>
				</div>
			{/if}

			{#if account.lostEdits > 0}
				<div class="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
					<ShieldAlertIcon class="size-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
					<p>
						{account.lostEdits} eigene {account.lostEdits === 1 ? "Änderung wurde" : "Änderungen wurden"} von einer neueren Fassung eines anderen Geräts überschrieben.
					</p>
				</div>
			{/if}

			{#if geraeteGeladen && geraete.length > 0}
				<div class="space-y-2 pt-1">
					<Label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
						Verknüpfte Geräte ({geraete.length})
					</Label>
					<div class="divide-y rounded-lg border bg-card">
						{#each geraete as g (g.id)}
							<div class="flex items-center justify-between gap-3 p-3 text-sm">
								<div class="flex items-center gap-3 min-w-0">
									<div class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
										{#if g.label.toLowerCase().includes("handy") || g.label.toLowerCase().includes("phone") || g.label.toLowerCase().includes("mobile")}
											<SmartphoneIcon class="size-4" />
										{:else}
											<LaptopIcon class="size-4" />
										{/if}
									</div>
									<div class="min-w-0">
										<div class="flex items-center gap-2">
											<p class="font-medium text-foreground truncate">{g.label}</p>
											{#if g.id === account.thisDeviceId}
												<Badge variant="secondary" class="text-[10px] px-1.5 py-0 h-4 font-normal">dieses Gerät</Badge>
											{/if}
										</div>
										<p class="text-muted-foreground text-xs">
											{g.lastSeenAt ? `Zuletzt aktiv: ${fmtDateHuman(g.lastSeenAt)}` : "Noch nie verbunden"}
										</p>
									</div>
								</div>
								{#if g.id !== account.thisDeviceId}
									<Button
										variant="ghost"
										size="sm"
										class="shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10 text-xs"
										onclick={() => (trenntGeraet = g)}
									>
										Trennen
									</Button>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<div class="space-y-2 rounded-lg border bg-muted/20 p-3.5">
				<div>
					<p class="font-medium text-sm text-foreground">Weiteres Gerät verknüpfen</p>
					<p class="text-muted-foreground text-xs">
						Auf dem neuen Gerät den Kopplungscode anzeigen lassen und hier bestätigen.
					</p>
				</div>
				<div class="flex flex-wrap gap-2 pt-1">
					<Input
						id="fremdcode"
						bind:value={fremderCode}
						placeholder="ABCD-EFGH-JKLM"
						maxlength={14}
						class="w-52 font-mono tracking-wider uppercase"
						onkeydown={(e) => e.key === "Enter" && fremderCode.trim() && !laeuft && bestaetigen()}
					/>
					<Button onclick={bestaetigen} disabled={laeuft || !fremderCode.trim()}>
						{laeuft ? "Verknüpft…" : "Verknüpfen"}
					</Button>
				</div>
			</div>
		{:else if warten}
			<div class="border-t pt-3">
				<PairingCode {code} onCancel={abbrechen} />
			</div>
		{:else}
			<div class="space-y-2 border-t pt-3">
				{#if DEFAULT_SERVER && !eigenerServer}
					<p class="text-sm">
						Server: <span class="font-medium">{DEFAULT_SERVER}</span>
					</p>
					<button
						type="button"
						class="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
						onclick={() => (eigenerServer = true)}
					>
						Eigenen Server verwenden
					</button>
				{:else}
					<Label for="srv">Adresse des Servers</Label>
					<Input id="srv" bind:value={serverUrl} placeholder="https://tracker.example.de" />
					{#if DEFAULT_SERVER}
						<button
							type="button"
							class="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
							onclick={() => {
								eigenerServer = false;
								serverUrl = DEFAULT_SERVER;
							}}
						>
							Zurück zu {DEFAULT_SERVER}
						</button>
					{/if}
				{/if}

				<!-- Konto entsteht im Browser (Passkey haengt an der Domain des Servers,
				     die App hat keine), dieses Geraet koppelt sich danach nur an. Lokale
				     Zeiten gehen beim ersten Abgleich trotzdem hoch (siehe Nachlese). -->
				<div class="space-y-2 pt-3">
					<Button disabled={laeuft || !serverUrl.trim()} onclick={losgehen}>
						{laeuft ? "Öffnet…" : "Konto anlegen und verknüpfen"}
					</Button>
					<p class="text-muted-foreground text-xs">
						Öffnet den Browser direkt beim Anlegen. Sobald das Konto steht, legt der
						Browser den Code von hier zum Bestätigen vor – abtippen musst du ihn nicht,
						nur mit dem Code unten vergleichen.
					</p>
				</div>

				<div class="space-y-2 border-t pt-3">
					<p class="text-sm font-medium">Konto gibt es schon?</p>
					<Button variant="outline" onclick={koppelnStarten} disabled={laeuft}>
						Kopplungscode anzeigen
					</Button>
					<p class="text-muted-foreground text-xs">
						Den Code auf einem Gerät bestätigen, das schon an dem Konto hängt.
					</p>
				</div>

				<!-- Einziger Weg zurueck, wenn kein anderes Geraet mehr bestaetigen kann. -->
				<div class="space-y-2 border-t pt-3">
					{#if !phraseEingabeOffen}
						<Button variant="ghost" size="sm" onclick={() => (phraseEingabeOffen = true)}>
							Mit Wiederherstellungs-Phrase zurückholen
						</Button>
						<p class="text-muted-foreground text-xs">
							Wenn kein Gerät mehr da ist, das bestätigen könnte.
						</p>
					{:else}
						<Label for="wphrase">Die 24 Wörter</Label>
						<textarea
							id="wphrase"
							bind:value={phraseEingabe}
							rows="3"
							class="border-input bg-background w-full rounded-md border p-2 font-mono text-sm"
							placeholder="wort eins wort zwei wort drei …"
						></textarea>
						<div class="flex gap-2">
							<Button onclick={zurueckholen} disabled={laeuft}>
								{laeuft ? "Sucht…" : "Konto zurückholen"}
							</Button>
							<Button
								variant="ghost"
								disabled={laeuft}
								onclick={() => {
									phraseEingabeOffen = false;
									phraseEingabe = "";
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

<Dialog.Root open={trenntGeraet !== null} onOpenChange={(o) => !o && (trenntGeraet = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>„{trenntGeraet?.label}" trennen?</Dialog.Title>
			<Dialog.Description>
				Das Gerät kommt danach nicht mehr an dieses Konto. Was dort erfasst wurde, bleibt auf
				diesem Gerät und beim Server – nur der Zugang ist weg. Zurück geht es über eine neue
				Kopplung.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (trenntGeraet = null)}>Abbrechen</Button>
			<Button variant="destructive" onclick={trennenBestaetigt}>Trennen</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={inviteOffen} onOpenChange={(o) => (inviteOffen = o)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Einladungscode</Dialog.Title>
			<Dialog.Description>
				Dieser Server nimmt keine offenen Registrierungen an.
			</Dialog.Description>
		</Dialog.Header>
		<Input
			bind:value={einladung}
			placeholder="ABCD-EFGH-JKLM-NPQR"
			class="font-mono tracking-wider uppercase"
			onkeydown={(e) => e.key === "Enter" && kontoAnlegen(einladung)}
		/>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (inviteOffen = false)}>Abbrechen</Button>
			<Button disabled={laeuft || !einladung.trim()} onclick={() => kontoAnlegen(einladung)}>
				{laeuft ? "Legt an…" : "Konto anlegen"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
