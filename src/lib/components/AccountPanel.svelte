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
		const c = fremderCode.trim().toUpperCase();
		if (c.length !== 8) {
			toast.error("Ein Kopplungscode hat acht Zeichen.");
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

	async function loesen() {
		await account.unlink();
		toast.success("Verknüpfung gelöst. Die lokalen Daten sind unverändert.");
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
						placeholder="ABCD2345"
						maxlength={8}
						class="w-40 font-mono tracking-widest uppercase"
					/>
					<Button onclick={bestaetigen} disabled={laeuft}>Bestätigen</Button>
				</div>
			</div>

			<div class="border-t pt-3">
				<Button variant="outline" size="sm" onclick={loesen}>Verknüpfung lösen</Button>
				<p class="text-muted-foreground mt-1 text-xs">
					Die erfassten Zeiten bleiben auf diesem Gerät erhalten.
				</p>
			</div>
		{:else if warten}
			<div class="space-y-2 border-t pt-3">
				<p class="text-sm">Diesen Code auf einem bereits verknüpften Gerät eintragen:</p>
				<p class="font-mono text-3xl tracking-[0.3em]">{code}</p>
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
