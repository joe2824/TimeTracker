<script lang="ts">
	// Der erste Bildschirm im Browser: anmelden oder Konto anlegen.
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import * as Card from "$lib/components/ui/card";
	import { toast } from "svelte-sonner";
	import { account } from "$lib/sync/account.svelte";
	import { addPasskeyWrap, login, register, unlockWithPhrase } from "$lib/sync/enroll";
	import { isValidRecoveryPhrase } from "$lib/crypto/vault";
	import { errorText } from "$lib/log";

	type Schritt = "start" | "phrase" | "entsperren";

	let schritt = $state<Schritt>("start");
	let laeuft = $state(false);

	// Die Adresse ist im Browser immer die eigene - die PWA wird ja vom Server
	// ausgeliefert. Sie steht trotzdem hier, damit klar ist, wohin die Daten gehen.
	const serverUrl = typeof location !== "undefined" ? location.origin : "";

	let invite = $state("");
	let phrase = $state("");
	let eingabe = $state("");
	let bestaetigt = $state(false);
	let prfVorhanden = $state(false);
	let angemeldeterName = $state("");
	let schluessel: CryptoKey | null = null;
	/**
	 * Was die Anmeldung an PRF hergab - fuer den Fall, dass gleich die Phrase
	 * gebraucht wird. Danach kann eine PRF-Verpackung nachgelegt werden, und die
	 * naechste Anmeldung kommt ohne die 24 Wörter aus.
	 */
	let prfWert: ArrayBuffer | null = null;
	let passkeyId = "";

	async function anmelden() {
		laeuft = true;
		try {
			const r = await login(serverUrl);
			angemeldeterName = r.displayName;
			prfWert = r.prf;
			passkeyId = r.credentialId;
			if (r.key) {
				await account.linkWithSession(serverUrl, r.key, r.displayName);
				toast.success(`Willkommen zurück, ${r.displayName}.`);
				return;
			}
			// Der Passkey konnte den Tresor nicht öffnen - das ist kein Fehler,
			// sondern der normale Weg auf Geräten ohne PRF-Unterstützung.
			if (!r.canUnlockWithPhrase) {
				toast.error("Für dieses Konto ist kein Weg hinterlegt, den Tresor zu öffnen.");
				return;
			}
			schritt = "entsperren";
		} catch (e) {
			toast.error(fehlertext(e, "Anmeldung fehlgeschlagen"));
		} finally {
			laeuft = false;
		}
	}

	async function anlegen() {
		try {
			const r = await register(serverUrl, { invite: invite.trim() || undefined });
			schluessel = r.key;
			phrase = r.recoveryPhrase!;
			prfVorhanden = r.prfAvailable;
			schritt = "phrase";
		} catch (e) {
			toast.error(fehlertext(e, "Konto konnte nicht angelegt werden"));
		} finally {
			laeuft = false;
		}
	}

	async function phraseUebernehmen() {
		if (!schluessel) return;
		await account.linkWithSession(serverUrl, schluessel);
		toast.success("Konto angelegt. Viel Erfolg!");
	}

	async function entsperren() {
		if (!isValidRecoveryPhrase(eingabe)) {
			// Die Prüfsumme von BIP39 fängt genau das ab, was beim Abtippen passiert.
			toast.error("Diese Phrase stimmt nicht – bitte alle 24 Wörter prüfen.");
			return;
		}
		laeuft = true;
		try {
			const key = await unlockWithPhrase(serverUrl, eingabe);
			// Kann der Passkey PRF, fehlte aber die passende Verpackung: jetzt eine
			// anlegen. Ohne das verlangte dieses Gerät die 24 Wörter bei JEDER
			// Anmeldung erneut - obwohl der Passkey den Tresor allein öffnen könnte.
			if (prfWert) {
				await addPasskeyWrap(serverUrl, key, passkeyId, prfWert).catch(() => {});
			}
			await account.linkWithSession(serverUrl, key);
			toast.success("Entsperrt.");
		} catch (e) {
			toast.error(fehlertext(e, "Die Phrase passt nicht zu diesem Konto"));
		} finally {
			laeuft = false;
		}
	}

	function fehlertext(e: unknown, standard: string): string {
		// Ein abgebrochener Passkey-Dialog ist keine Störung, sondern eine
		// Entscheidung - dafür braucht es keine Fehlermeldung mit Ausrufezeichen.
		if (e instanceof Error && /NotAllowed|abort/i.test(e.name + e.message)) {
			return "Abgebrochen.";
		}
		// `errorText` und nicht `e.message`: WebCrypto wirft beim Entsperren einen
		// OperationError, dessen Meldung in Chromium-Laufzeiten LEER ist.
		return e instanceof Error ? errorText(e) : standard;
	}

	// ---------- Mit der Phrase zurueckholen ----------

	let phraseOffen = $state(false);
	let phraseEingabe = $state("");

	async function zurueckholen() {
		laeuft = true;
		try {
			await account.recoverWithPhrase(serverUrl, phraseEingabe, "Browser");
			phraseOffen = false;
			phraseEingabe = "";
			toast.success("Konto zurückgeholt. Leg jetzt einen Passkey an, dann geht es künftig schneller.");
		} catch (e) {
			toast.error(fehlertext(e, "Zurückholen fehlgeschlagen"));
		} finally {
			laeuft = false;
		}
	}

	// ---------- Der Browser koppelt sich wie ein neues Geraet ----------

	let kopplungscode = $state("");
	let poll: ReturnType<typeof setInterval> | null = null;

	async function koppelnStarten() {
		laeuft = true;
		try {
			kopplungscode = await account.startPairing(serverUrl, "Browser");
			// Alle zwei Sekunden nachsehen. Der Server bremst das nicht aus - gezaehlt
			// werden dort nur Fehlgriffe, nicht das Warten.
			poll = setInterval(pruefen, 2000);
		} catch (e) {
			toast.error(fehlertext(e, "Kopplung konnte nicht begonnen werden"));
		} finally {
			laeuft = false;
		}
	}

	async function pruefen() {
		try {
			if (await account.checkPairing()) {
				koppelnAufraeumen();
				toast.success("Gerät gekoppelt. Leg jetzt einen Passkey an, dann geht es künftig schneller.");
			}
		} catch (e) {
			koppelnAufraeumen();
			toast.error(fehlertext(e, "Kopplung fehlgeschlagen"));
		}
	}

	function koppelnAbbrechen() {
		account.cancelPairing();
		koppelnAufraeumen();
	}

	function koppelnAufraeumen() {
		if (poll) clearInterval(poll);
		poll = null;
		kopplungscode = "";
	}

	$effect(() => () => {
		if (poll) clearInterval(poll);
	});

	async function kopieren() {
		try {
			await navigator.clipboard.writeText(phrase);
			toast.success("In die Zwischenablage kopiert.");
		} catch {
			toast.error("Kopieren nicht möglich – bitte abschreiben.");
		}
	}
</script>

<div class="mx-auto flex min-h-dvh max-w-lg items-center p-4">
	{#if schritt === "start"}
		<Card.Root class="w-full">
			<Card.Header>
				<Card.Title>TimeTracker</Card.Title>
				<Card.Description>
					Zeiten erfassen – auch wenn der Rechner aus ist.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<Button class="w-full" disabled={laeuft} onclick={anmelden}>Mit Passkey anmelden</Button>

				<div class="space-y-2 border-t pt-4">
					<p class="text-sm font-medium">Neues Konto</p>
					<Label for="inv" class="pt-2">Einladungscode</Label>
					<Input id="inv" bind:value={invite} placeholder="falls erforderlich" />
					<Button variant="outline" class="mt-2 w-full" disabled={laeuft} onclick={anlegen}>
						Konto anlegen
					</Button>
					<p class="text-muted-foreground text-xs">
						Kein Passwort, keine E-Mail-Pflicht. Es wird ein Passkey auf diesem Gerät
						angelegt.
					</p>
				</div>

				<!-- Der dritte Weg, und ohne ihn waere einer der anderen eine Sackgasse.

				     Ein Konto, das aus der Desktop-Anwendung heraus angelegt wurde, hat
				     keinen Passkey - die Anwendung hat keine Domain und kann keinen
				     anbieten. Im Browser käme man da mit "Mit Passkey anmelden" nie
				     hinein.

				     Also koppelt sich der Browser wie jedes andere neue Gerät: Code
				     anzeigen, am Rechner bestätigen. Danach lässt sich hier ein Passkey
				     anlegen, und ab dann geht auch der bequeme Weg. -->
				<div class="space-y-2 border-t pt-4">
					<p class="text-sm font-medium">Oder: zu einem Konto dazu, das es schon gibt</p>
					{#if kopplungscode}
						<p class="font-mono text-2xl tracking-[0.2em]">{kopplungscode}</p>
						<p class="text-muted-foreground text-xs">
							Diesen Code am Rechner unter „Konto &amp; Synchronisation“ bestätigen. Er gilt
							zehn Minuten.
						</p>
						<Button variant="ghost" size="sm" onclick={koppelnAbbrechen}>Abbrechen</Button>
					{:else}
						<Button variant="outline" class="w-full" disabled={laeuft} onclick={koppelnStarten}>
							Dieses Gerät koppeln
						</Button>
					{/if}
				</div>

				<!-- Und der Weg für den Tag, an dem gar nichts mehr da ist. -->
				<div class="space-y-2 border-t pt-4">
					{#if !phraseOffen}
						<Button
							variant="ghost"
							size="sm"
							class="w-full"
							onclick={() => (phraseOffen = true)}
						>
							Mit Wiederherstellungs-Phrase zurückholen
						</Button>
					{:else}
						<Label for="wph">Die 24 Wörter</Label>
						<textarea
							id="wph"
							bind:value={phraseEingabe}
							rows="3"
							class="border-input bg-background w-full rounded-md border p-2 font-mono text-sm"
							placeholder="wort eins wort zwei wort drei …"
						></textarea>
						<Button class="w-full" disabled={laeuft} onclick={zurueckholen}>
							{laeuft ? "Sucht…" : "Konto zurückholen"}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							class="w-full"
							disabled={laeuft}
							onclick={() => {
								phraseOffen = false;
								// Mitnehmen, nicht bloss ausblenden: sonst stehen die Woerter beim
								// naechsten Aufklappen wieder sichtbar im Feld.
								phraseEingabe = "";
							}}
						>
							Abbrechen
						</Button>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>
	{:else if schritt === "phrase"}
		<Card.Root class="w-full">
			<Card.Header>
				<Card.Title>Wiederherstellungs-Phrase sichern</Card.Title>
				<Card.Description>
					Diese 24 Wörter sind der einzige Weg zurück zu deinen Daten, wenn du alle Geräte
					verlierst. Sie werden <strong>nur jetzt</strong> angezeigt – der Server kennt sie
					nicht und kann sie nicht noch einmal zeigen.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<ol class="bg-muted grid grid-cols-2 gap-x-4 gap-y-1 rounded-md p-3 text-sm sm:grid-cols-3">
					{#each phrase.split(" ") as wort, i (i)}
						<li class="flex gap-2">
							<span class="text-muted-foreground w-5 text-right tabular-nums">{i + 1}.</span>
							<span class="font-mono">{wort}</span>
						</li>
					{/each}
				</ol>

				<Button variant="outline" size="sm" onclick={kopieren}>In Zwischenablage kopieren</Button>

				{#if !prfVorhanden}
					<!--
						Ohne PRF öffnet der Passkey den Tresor nicht allein. Dann ist die
						Phrase nicht das Netz, sondern der Alltagsweg - das gehört gesagt.
					-->
					<p class="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
						Dieses Gerät unterstützt die Passkey-Erweiterung nicht, mit der sich der Tresor
						beim Anmelden von selbst öffnet. Du wirst die Phrase bei jeder Anmeldung auf
						diesem Gerät brauchen.
					</p>
				{/if}

				<label class="flex items-start gap-2 text-sm">
					<input type="checkbox" bind:checked={bestaetigt} class="mt-0.5" />
					<span>
						Ich habe die 24 Wörter an einem sicheren Ort gesichert. Mir ist klar, dass meine
						Daten ohne sie bei Verlust aller Geräte unwiederbringlich weg sind.
					</span>
				</label>

				<Button class="w-full" disabled={!bestaetigt} onclick={phraseUebernehmen}>
					Weiter
				</Button>
			</Card.Content>
		</Card.Root>
	{:else}
		<Card.Root class="w-full">
			<Card.Header>
				<Card.Title>Tresor entsperren</Card.Title>
				<Card.Description>
					Dieses Gerät kann den Tresor nicht allein öffnen. Bitte die 24 Wörter eingeben.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-3">
				<textarea
					bind:value={eingabe}
					rows="4"
					class="border-input bg-background w-full rounded-md border p-2 font-mono text-sm"
					placeholder="wort1 wort2 wort3 …"
				></textarea>
				<Button class="w-full" disabled={laeuft} onclick={entsperren}>Entsperren</Button>
				<Button variant="ghost" size="sm" onclick={() => (schritt = "start")}>Zurück</Button>
			</Card.Content>
		</Card.Root>
	{/if}
</div>
