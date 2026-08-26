<script lang="ts">
	// Konto & Synchronisation.
	//
	// Die Oberflaeche zu einer Sache, die man nur einmal macht und danach nie
	// wieder ansieht. Deshalb steht im Normalfall genau eine Zeile da - Zustand,
	// letzter Abgleich - und alles Weitere nur, wenn es etwas zu tun gibt.
	import * as Card from "$lib/components/ui/card";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import SettingRow from "$lib/components/SettingRow.svelte";
	import { toast } from "svelte-sonner";
	import { account } from "$lib/sync/account.svelte";
	import { formatPairingCode, isPairingCode, normalizePairingCode } from "$lib/crypto/vault";
	import { fmtDateHuman, fmtClock } from "$lib/time";
	import { capabilities } from "$lib/platform/env";

	let serverUrl = $state("");
	let geraetename = $state("");
	let code = $state("");
	let fremderCode = $state("");
	let laeuft = $state(false);
	/** Warten auf die Bestaetigung des anderen Geraets. */
	let warten = $state(false);
	let poll: ReturnType<typeof setInterval> | null = null;

	const zustand = $derived.by(() => {
		if (account.state === "aus") return { text: "Nicht verknüpft", ton: "text-muted-foreground" };
		if (account.state === "verbindet") return { text: "Verbinde…", ton: "text-muted-foreground" };
		if (account.state === "fehler") return { text: account.message, ton: "text-destructive" };
		if (account.phase === "offline") return { text: "Offline – Änderungen warten", ton: "text-amber-600" };
		if (account.phase === "laeuft") return { text: "Gleicht ab…", ton: "text-muted-foreground" };
		if (account.phase === "fehler") return { text: account.message, ton: "text-destructive" };
		return { text: "Verknüpft", ton: "text-emerald-600" };
	});

	function vorschlagName(): string {
		// Ein Name, den man in der Geraeteliste wiedererkennt, ohne ihn zu tippen.
		const p = navigator.platform || "Gerät";
		return capabilities.tray ? `Rechner (${p})` : `Browser (${p})`;
	}

	async function koppelnStarten() {
		const url = serverUrl.trim();
		if (!url) {
			toast.error("Bitte die Adresse des Servers angeben.");
			return;
		}
		laeuft = true;
		try {
			code = await account.startPairing(url, geraetename.trim() || vorschlagName());
			warten = true;
			// Nachsehen, ob jemand bestaetigt hat. Kein Kanal: der Vorgang dauert
			// Sekunden, und jemand sieht dabei zu.
			poll = setInterval(pruefen, 2000);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Kopplung nicht möglich");
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
			toast.error(e instanceof Error ? e.message : "Kopplung fehlgeschlagen");
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
			toast.error(e instanceof Error ? e.message : "Code konnte nicht bestätigt werden");
		} finally {
			laeuft = false;
		}
	}

	/**
	 * Entkoppeln - in drei Stufen, weil das Wort drei Dinge heissen kann.
	 *
	 * In JEDER davon bleiben die erfassten Zeiten auf diesem Geraet vollstaendig
	 * erhalten. Das ist keine Beruhigungsformel: der Server war nie ihre einzige
	 * Kopie, und genau das laesst sich hier nachpruefen.
	 */
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
			toast.error(e instanceof Error ? e.message : "Lösen fehlgeschlagen");
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
			toast.error(e instanceof Error ? e.message : "Auflösen fehlgeschlagen");
		} finally {
			laeuft = false;
		}
	}

	$effect(() => () => {
		if (poll) clearInterval(poll);
	});
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Konto & Synchronisation</Card.Title>
		<Card.Description>
			Optional. Ohne verknüpftes Konto bleibt alles auf diesem Rechner – so wie bisher.
		</Card.Description>
	</Card.Header>

	<Card.Content class="space-y-4">
		<SettingRow title="Status" description={account.linked ? account.serverUrl : "Zeiten nur auf diesem Gerät."}>
			{#snippet control()}
				<span class="text-sm font-medium {zustand.ton}">{zustand.text}</span>
			{/snippet}
		</SettingRow>

		{#if account.linked}
			<SettingRow
				title="Letzter Abgleich"
				description={account.pending > 0
					? `${account.pending} Änderung${account.pending === 1 ? "" : "en"} noch nicht übertragen.`
					: "Alles übertragen."}
				class="border-t pt-3"
			>
				{#snippet control()}
					<div class="flex items-center gap-2">
						<span class="text-muted-foreground text-sm">
							{#if account.lastSync}
								{fmtClock(account.lastSync)}
							{:else}
								–
							{/if}
						</span>
						<Button variant="outline" size="sm" onclick={() => account.syncNow()}>Jetzt</Button>
					</div>
				{/snippet}
			</SettingRow>

			{#if !account.secretsProtected}
				<!--
					Nicht verschweigen: ohne Schutz durch das Betriebssystem liegen
					Schlüssel und Token lesbar im Datenordner. Wer das weiß, kann
					entscheiden; wer es nicht weiß, kann es nicht.
				-->
				<p class="text-muted-foreground border-t pt-3 text-xs">
					Schlüssel und Zugang liegen auf diesem Gerät <strong>ungeschützt</strong> im
					Datenordner – das Betriebssystem bietet hier keine Ablage dafür. Behandle den Ordner
					entsprechend.
				</p>
			{/if}

			{#if account.lostEdits > 0}
				<p class="border-t pt-3 text-xs text-amber-600">
					{account.lostEdits} eigene Änderung{account.lostEdits === 1 ? "" : "en"} wurde{account.lostEdits === 1 ? "" : "n"}
					von einer neueren Fassung eines anderen Geräts überschrieben.
				</p>
			{/if}

			<div class="space-y-2 border-t pt-3">
				<Label for="fremdcode">Weiteres Gerät verknüpfen</Label>
				<p class="text-muted-foreground text-xs">
					Auf dem neuen Gerät den Kopplungscode anzeigen lassen und hier eintragen. Der
					Schlüssel wird dabei für dieses eine Gerät verpackt – der Server sieht ihn nie.
				</p>
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
						Die erfassten Zeiten bleiben auf diesem Gerät erhalten.
					</p>
				{:else}
					<div class="space-y-3">
						<p class="text-sm font-medium">Wie weit soll es gehen?</p>

						<div class="space-y-1">
							<Button variant="outline" size="sm" disabled={laeuft} onclick={() => loesen()}>
								Nur hier vergessen
							</Button>
							<p class="text-muted-foreground text-xs">
								Dieses Gerät gleicht nicht mehr ab. Der Zugang bleibt gültig – es lässt sich
								jederzeit wieder koppeln.
							</p>
						</div>

						<!--
							Nur mit eigenem Geraete-Token. Eine Browser-Sitzung weist sich mit
							einem Cookie aus und IST kein Geraet beim Server - sie hat dort
							nichts zu loesen, und der Server lehnt es mit 400 ab. Die
							Schaltflaeche konnte also nur fehlschlagen. Wer die Sitzung
							beenden will, meldet sich ab.
						-->
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
									Die Zeiten auf diesem Rechner bleiben.
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
			<div class="space-y-2 border-t pt-3">
				<p class="text-sm">Diesen Code auf einem bereits verknüpften Gerät eintragen:</p>
				<p class="font-mono text-2xl tracking-[0.2em]">{formatPairingCode(code)}</p>
				<p class="text-muted-foreground text-xs">
					Der Code gilt zehn Minuten. Wird gewartet, bis jemand bestätigt hat…
				</p>
				<Button variant="outline" size="sm" onclick={abbrechen}>Abbrechen</Button>
			</div>
		{:else}
			<div class="space-y-2 border-t pt-3">
				<Label for="srv">Adresse des Servers</Label>
				<Input id="srv" bind:value={serverUrl} placeholder="https://tracker.example.de" />
				<Label for="gname" class="pt-2">Name dieses Geräts</Label>
				<Input id="gname" bind:value={geraetename} placeholder={vorschlagName()} />
				<Button onclick={koppelnStarten} disabled={laeuft} class="mt-2">
					Kopplungscode anzeigen
				</Button>
				<p class="text-muted-foreground text-xs">
					Es braucht ein bestehendes Konto und ein Gerät, das darauf schon Zugriff hat. Beim
					ersten Gerät wird das Konto im Browser angelegt.
				</p>
			</div>
		{/if}
	</Card.Content>
</Card.Root>
