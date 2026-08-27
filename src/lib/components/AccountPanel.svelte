<script lang="ts">
	import * as Card from "$lib/components/ui/card";
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
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

	function vorschlagName(): string {
		// Ein Name, den man in der Geraeteliste wiedererkennt, ohne ihn zu tippen.
		const p = navigator.platform || "Gerät";
		return capabilities.tray ? `Rechner (${p})` : `Browser (${p})`;
	}

	/** Kopplungscode holen und Browser direkt mit dem Code im Link oeffnen, statt ihn abtippen zu lassen. */
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
			await openExternal(anlegenLink(url, code));
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

	/** Entkoppeln - in drei Stufen, weil das Wort drei Dinge heissen kann. */
	let loesenOffen = $state(false);
	let aufloesenOffen = $state(false);
	/** Wie viele Geraete am Konto haengen - entscheidet, was das Aufloesen bedeutet. */
	let geraeteAmKonto = $state<number | null>(null);

	async function dialogOeffnen() {
		loesenOffen = true;
		geraeteAmKonto = null;
		try {
			const info = await account.accountInfo();
			geraeteAmKonto = info ? info.devices.filter((d) => !d.revokedAt).length : null;
		} catch {
			// Nicht erreichbar - dann steht die Zahl eben nicht da. Das lokale Loesen
			// muss trotzdem gehen: ein Server, der gerade weg ist, darf niemanden an
			// sein Konto fesseln.
			geraeteAmKonto = null;
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

	async function loesen(opts: { revokeSelf?: boolean } = {}) {
		laeuft = true;
		try {
			await account.unlink(opts);
			loesenOffen = false;
			toast.success(
				opts.revokeSelf
					? "Gerät vom Konto getrennt. Die erfassten Zeiten bleiben hier."
					: "Verknüpfung gelöst. Die erfassten Zeiten bleiben hier."
			);
		} catch (e) {
			toast.error(fehlertext(e, "Lösen fehlgeschlagen"));
		} finally {
			laeuft = false;
		}
	}

	async function aufloesen() {
		laeuft = true;
		try {
			const summe = await account.unlink({ deleteRemote: true });
			aufloesenOffen = false;
			loesenOffen = false;
			toast.success(
				summe
					? `Konto aufgelöst. ${summe.records} Datensätze beim Server gelöscht. Die Zeiten bleiben hier.`
					: "Konto aufgelöst. Die Zeiten bleiben hier."
			);
		} catch (e) {
			// Wichtig: lokal ist dann NICHTS passiert. Sonst haette jemand ein Gerät
			// ohne Zugang und Daten, die trotzdem noch beim Server liegen.
			toast.error(fehlertext(e, "Auflösen fehlgeschlagen"));
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

<Card.Root class="lg:col-span-2">
	<Card.Header>
		<Card.Title>Konto & Synchronisation</Card.Title>
		<Card.Description>
			Optional. Ohne verknüpftes Konto bleibt alles auf diesem Rechner – so wie bisher.
		</Card.Description>
	</Card.Header>

	<Card.Content class="space-y-4">
		{#if phrase}
			<!-- Kein Wegklick-Button, sondern ein Haekchen: ohne zweites Geraet oder
			     Passkey sind diese 24 Woerter der einzige Weg zu den Daten - auch der
			     Betreiber kann nichts entschluesseln. -->
			<div class="border-primary/40 space-y-3 rounded-md border p-4">
				<div>
					<p class="font-medium">Deine Wiederherstellungs-Phrase</p>
					<p class="text-muted-foreground text-sm">
						Wird genau einmal gezeigt. Solange kein Passkey und kein zweites Gerät da ist,
						sind diese Wörter der einzige Weg zu deinen Zeiten.
					</p>
				</div>

				<p class="bg-muted rounded-md p-3 font-mono text-sm leading-relaxed select-all">
					{phrase}
				</p>

				<label class="flex items-start gap-2 text-sm">
					<input type="checkbox" bind:checked={phraseBestaetigt} class="mt-1" />
					<span>Ich habe die Phrase gesichert.</span>
				</label>

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

		<!-- Nur Verknuepfung + Status; wann zuletzt abgeglichen wurde, steht schon oben in der Kopfzeile. -->
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div class="flex items-center gap-2 text-sm">
				<span class="size-2 shrink-0 rounded-full {zustand.punkt}"></span>
				<span class="font-medium">{zustand.text}</span>
				{#if account.linked && account.serverUrl}
					<span class="text-muted-foreground truncate">· {account.serverUrl}</span>
				{/if}
			</div>
			{#if account.linked}
				<Button variant="ghost" size="sm" onclick={() => account.syncNow()}>Jetzt abgleichen</Button>
			{/if}
		</div>

		{#if account.linked}
			{#if account.pending > 0}
				<p class="text-muted-foreground text-xs">
					{account.pending} Änderung{account.pending === 1 ? "" : "en"} noch nicht übertragen.
				</p>
			{/if}

			{#if !account.secretsProtected}
				<p class="text-muted-foreground border-t pt-3 text-xs">
					Schlüssel und Zugang liegen hier <strong>ungeschützt</strong> im Datenordner – das
					Betriebssystem bietet keine geschützte Ablage.
				</p>
			{/if}

			{#if account.lostEdits > 0}
				<p class="border-t pt-3 text-xs text-amber-600">
					{account.lostEdits} eigene Änderung{account.lostEdits === 1 ? "" : "en"} wurde{account.lostEdits === 1 ? "" : "n"}
					von einer neueren Fassung eines anderen Geräts überschrieben.
				</p>
			{/if}

			{#if geraeteGeladen && geraete.length > 0}
				<div class="space-y-1 border-t pt-3">
					<p class="text-sm font-medium">Verknüpfte Geräte</p>
					{#each geraete as g (g.id)}
						<div class="flex items-center justify-between gap-2 border-b py-2 text-sm last:border-0">
							<div class="min-w-0">
								<p class="truncate font-medium">
									{g.label}
									{#if g.id === account.thisDeviceId}
										<span class="text-muted-foreground font-normal"> · dieses Gerät</span>
									{/if}
								</p>
								<p class="text-muted-foreground text-xs">
									{g.lastSeenAt ? `zuletzt ${fmtDateHuman(g.lastSeenAt)}` : "noch nie verbunden"}
								</p>
							</div>
							{#if g.id !== account.thisDeviceId}
								<!-- Das eigene Geraet nicht: dafuer gibt es „Entkoppeln“, das auch
								     lokal aufraeumt. Hier waere es ein Zugang, der sich selbst zusperrt. -->
								<Button variant="ghost" size="sm" onclick={() => (trenntGeraet = g)}>Trennen</Button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			<div class="space-y-2 border-t pt-3">
				<Label for="fremdcode">Weiteres Gerät verknüpfen</Label>
				<p class="text-muted-foreground text-xs">
					Code vom neuen Gerät hier eintragen.
				</p>
				{#if capabilities.tray && account.serverUrl}
					<!-- Nur auf dem Rechner: im Browser sitzt man schon dort, wo der Code
					     entsteht - der Knopf zeigte dann auf die eigene Seite. -->
					<Button variant="outline" size="sm" onclick={() => openExternal(account.serverUrl)}>
						Im Browser öffnen
					</Button>
				{/if}
				<div class="flex gap-2">
					<Input
						id="fremdcode"
						bind:value={fremderCode}
						placeholder="ABCD-EFGH-JKLM"
						maxlength={14}
						class="w-52 font-mono tracking-wider uppercase"
					/>
					<Button onclick={bestaetigen} disabled={laeuft}>Bestätigen</Button>
				</div>
			</div>

			<div class="border-t pt-3">
				{#if !loesenOffen}
					<Button variant="outline" size="sm" onclick={dialogOeffnen}>Entkoppeln…</Button>
					<p class="text-muted-foreground mt-1 text-xs">
						Die Zeiten auf diesem Gerät bleiben in jedem Fall. Was beim Server passiert,
						wählst du gleich.
					</p>
				{:else}
					<div class="space-y-3">
						<p class="text-sm font-medium">Wie weit soll es gehen?</p>

						<div class="space-y-1">
							<Button variant="outline" size="sm" disabled={laeuft} onclick={() => loesen()}>
								Nur hier vergessen
							</Button>
							<p class="text-muted-foreground text-xs">
								Kein Abgleich mehr. Wieder koppeln geht jederzeit.
							</p>
						</div>

						<!-- Nur mit eigenem Geraete-Token: eine Browser-Sitzung ist beim Server
						     kein Geraet und laesst sich hier nicht trennen (400). -->
						{#if account.hasDeviceToken}
							<div class="space-y-1">
								<Button
									variant="outline"
									size="sm"
									disabled={laeuft}
									onclick={() => loesen({ revokeSelf: true })}
								>
									Gerät vom Konto trennen
								</Button>
								<p class="text-muted-foreground text-xs">
									Der Zugang dieses Geräts erlischt auch beim Server. Das Konto und alle anderen
									Geräte bleiben.
								</p>
							</div>
						{/if}

						<div class="space-y-1">
							{#if !aufloesenOffen}
								<Button
									variant="destructive"
									size="sm"
									disabled={laeuft}
									onclick={() => (aufloesenOffen = true)}
								>
									Konto auflösen
								</Button>
								<p class="text-muted-foreground text-xs">
									Alles beim Server wird gelöscht – auch für
									{#if geraeteAmKonto === null}
										alle anderen Geräte.
									{:else if geraeteAmKonto <= 1}
										dieses eine Gerät.
									{:else}
										die {geraeteAmKonto} verknüpften Geräte.
									{/if}
									Die Datensätze dort werden gelöscht; die Zeiten auf diesem Gerät bleiben.
								</p>
							{:else}
								<div class="border-destructive/40 space-y-2 rounded-md border p-3">
									<p class="text-sm">
										Das lässt sich nicht rückgängig machen. Alle verschlüsselten Datensätze,
										Passkeys und Geräte dieses Kontos werden beim Server gelöscht.
									</p>
									<p class="text-muted-foreground text-xs">
										Die erfassten Zeiten auf diesem Rechner bleiben vollständig erhalten – der
										Server war nie ihre einzige Kopie.
									</p>
									<div class="flex gap-2">
										<Button variant="destructive" size="sm" disabled={laeuft} onclick={aufloesen}>
											{laeuft ? "Löscht…" : "Endgültig auflösen"}
										</Button>
										<Button
											variant="ghost"
											size="sm"
											disabled={laeuft}
											onclick={() => (aufloesenOffen = false)}
										>
											Zurück
										</Button>
									</div>
								</div>
							{/if}
						</div>

						<Button
							variant="ghost"
							size="sm"
							disabled={laeuft}
							onclick={() => {
								loesenOffen = false;
								aufloesenOffen = false;
							}}>Abbrechen</Button
						>
					</div>
				{/if}
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
						Öffnet den Browser direkt beim Anlegen. Sobald das Konto steht, ist dieser
						Rechner verknüpft – ohne dass du etwas abtippst.
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
