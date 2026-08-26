<script lang="ts">
	// Der erste Bildschirm im Browser: anmelden oder Konto anlegen.
	//
	// Er steht vor allem anderen, weil es ohne Konto im Browser nichts zu zeigen
	// gibt - anders als auf dem Rechner, wo die Daten ohnehin lokal liegen.
	//
	// Der wichtigste Teil ist nicht die Anmeldung, sondern der Bildschirm mit der
	// Wiederherstellungs-Phrase. Sie wird genau EINMAL angezeigt, und wer sie
	// wegklickt, ohne sie zu sichern, hat bei Verlust aller Geräte keinen Weg
	// mehr zu seinen Daten. Deshalb ist dieser Schritt nicht überspringbar und
	// verlangt eine Bestätigung, die man nicht versehentlich gibt.
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import * as Card from "$lib/components/ui/card";
	import { toast } from "svelte-sonner";
	import { account } from "$lib/sync/account.svelte";
	import { addPasskeyWrap, login, register, unlockWithPhrase } from "$lib/sync/enroll";
	import { isValidRecoveryPhrase } from "$lib/crypto/vault";

	type Schritt = "start" | "phrase" | "entsperren";

	let schritt = $state<Schritt>("start");
	let laeuft = $state(false);

	// Die Adresse ist im Browser immer die eigene - die PWA wird ja vom Server
	// ausgeliefert. Sie steht trotzdem hier, damit klar ist, wohin die Daten gehen.
	const serverUrl = typeof location !== "undefined" ? location.origin : "";

	let name = $state("");
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
		if (!name.trim()) {
			toast.error("Bitte einen Anzeigenamen angeben.");
			return;
		}
		laeuft = true;
		try {
			const r = await register(serverUrl, name.trim(), { invite: invite.trim() || undefined });
			schluessel = r.key;
			phrase = r.recoveryPhrase!;
			prfVorhanden = r.prfAvailable;
			angemeldeterName = r.displayName;
			schritt = "phrase";
		} catch (e) {
			toast.error(fehlertext(e, "Konto konnte nicht angelegt werden"));
		} finally {
			laeuft = false;
		}
	}

	async function phraseUebernehmen() {
		if (!schluessel) return;
		await account.linkWithSession(serverUrl, schluessel, angemeldeterName);
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
			//
			// Nebenher und ohne Meldung: es gibt nichts zu entscheiden, und ein
			// Fehlschlag darf die geglückte Entsperrung nicht in eine Fehlermeldung
			// verwandeln. Dann bleibt es eben beim bisherigen Weg.
			if (prfWert) {
				await addPasskeyWrap(serverUrl, key, passkeyId, prfWert).catch(() => {});
			}
			await account.linkWithSession(serverUrl, key, angemeldeterName);
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
		return e instanceof Error ? e.message : standard;
	}

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
					Zeiten erfassen – auch wenn der Rechner aus ist. Die Daten werden auf diesem Gerät
					verschlüsselt; der Server kann sie nicht lesen.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<Button class="w-full" disabled={laeuft} onclick={anmelden}>Mit Passkey anmelden</Button>

				<div class="space-y-2 border-t pt-4">
					<p class="text-sm font-medium">Neues Konto</p>
					<Label for="n">Anzeigename</Label>
					<Input id="n" bind:value={name} placeholder="dein Name" autocomplete="username" />
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
