<script lang="ts">
	// Der erste Bildschirm im Browser: anmelden oder Konto anlegen.
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import * as Card from "$lib/components/ui/card";
	import { toast } from "svelte-sonner";
	import { account } from "$lib/sync/account.svelte";
	import { app } from "$lib/app.svelte";
	import { ApiError, addPasskeyWrap, login, register, unlockWithPhrase } from "$lib/sync/enroll";
	import * as Dialog from "$lib/components/ui/dialog";
	import PairingCode from "$lib/components/PairingCode.svelte";
	import DownloadIcon from "@lucide/svelte/icons/download";
	import LockIcon from "@lucide/svelte/icons/lock";
	import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
	import KeyRoundIcon from "@lucide/svelte/icons/key-round";
	import { RELEASES_URL, erkenneOS, hatDesktopApp } from "$lib/platform/os";
	import { errorText, logWarn } from "$lib/log";
	import { linkParameter } from "$lib/invite";
	import { onboardingOffen } from "$lib/onboarding.svelte";
	import { isPairingCode, isValidRecoveryPhrase, normalizePairingCode } from "$lib/crypto/vault";

	type Schritt = "start" | "phrase" | "entsperren" | "geraet";

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
	let prfWert: Uint8Array | null = null;
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
			// Kein Sackgassen-Toast. WebAuthn sagt nicht, OB es einen Passkey gibt -
			// abgebrochen und "gar keiner da" kommen als derselbe Fehler an. Statt zu
			// raten, zeigen wir die Wege, die es von hier aus gibt.
			hilfeOffen = true;
			logWarn("Anmeldung fehlgeschlagen", e);
		} finally {
			laeuft = false;
		}
	}

	/** Nach einer gescheiterten Anmeldung: wie geht es weiter? */
	let hilfeOffen = $state(false);

	/** Steht die Frage nach dem Einladungscode offen? */
	let inviteOffen = $state(false);

	/** Einmal ermitteln - das aendert sich waehrend einer Sitzung nicht. */
	const os = erkenneOS();

	// Was der Link mitgebracht hat. Wird dabei aus der Adresszeile entfernt - alles
	// davon gilt genau einmal und nuetzt in der Chronik niemandem.
	const vomLink = $state(linkParameter());
	const ausLink = vomLink.invite;
	if (ausLink) invite = ausLink;

	/**
	 * Der Rechner hat diesen Link geoeffnet und seinen Kopplungscode mitgeschickt.
	 *
	 * Sobald hier ein Konto steht, wird er bestaetigt - der Rechner haengt dann
	 * dran, ohne dass jemand zwoelf Zeichen abtippt. Nur ein Bestaetigen, kein
	 * Anmelden: der Code allein oeffnet keinen Tresor.
	 */
	async function rechnerDazuholen() {
		if (!vomLink.pair) return;
		try {
			const label = await account.approvePairing(vomLink.pair);
			toast.success(`„${label}" ist jetzt verknüpft.`);
		} catch (e) {
			// Der Code ist nach zehn Minuten hin, oder der Vorgang wurde abgebrochen.
			// Kein Grund, das frisch angelegte Konto schlechtzureden.
			logWarn("Rechner konnte nicht dazugeholt werden", e);
		}
	}

	/**
	 * Ein Konto anlegen - ohne vorher nach einem Einladungscode zu fragen.
	 *
	 * Ob einer noetig ist, weiss nur der Server, und die meisten Installationen
	 * brauchen keinen. Ein Feld, das fast immer leer bleibt, steht sonst als
	 * erstes im Weg. Verlangt der Server einen, kommt er mit 403 zurueck - dann
	 * ist der richtige Moment, danach zu fragen.
	 */
	async function anlegen(code = "") {
		hilfeOffen = false;
		laeuft = true;
		try {
			// Der Name aus dem Willkommensbildschirm, falls einer dasteht. Kein Pflichtfeld:
			// ohne ihn setzt der Server die Kontokennung ein.
			const r = await register(serverUrl, app.settings.senderName.trim(), {
				invite: code.trim() || undefined
			});
			angemeldeterName = r.displayName;
			schluessel = r.key;
			phrase = r.recoveryPhrase!;
			prfVorhanden = r.prfAvailable;
			inviteOffen = false;
			schritt = "phrase";
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

	async function phraseUebernehmen() {
		if (!schluessel) return;
		// VOR dem Verknuepfen: in dem Moment, in dem das Konto haengt, baut die
		// Seite diesen Bildschirm ab - und der letzte Schritt ginge mit ihm. Wer
		// das Flag erst danach setzt, sieht ihn nie.
		onboardingOffen.wert = true;
		await account.linkWithSession(serverUrl, schluessel, angemeldeterName);
		// Reihenfolge: erst muss DIESER Browser am Konto haengen, sonst darf er
		// keinen fremden Kopplungscode bestaetigen.
		await rechnerDazuholen();

		// Kam der Anstoss vom Rechner, ist der schon dabei - dann gibt es nichts
		// mehr zu fragen. Sonst noch der eine Schritt, und dafuer bleibt dieser
		// Bildschirm stehen, obwohl das Konto bereits haengt.
		if (vomLink.pair) {
			onboardingOffen.wert = false;
			toast.success("Konto angelegt und Rechner verknüpft.");
			return;
		}
		schritt = "geraet";
	}

	/** Den Code aus der Desktop-Anwendung bestaetigen. */
	async function appDazuholen() {
		const c = normalizePairingCode(appCode);
		if (!isPairingCode(c)) {
			toast.error("Ein Kopplungscode hat zwölf Zeichen.");
			return;
		}
		laeuft = true;
		try {
			const label = await account.approvePairing(c);
			appCode = "";
			fertig();
			toast.success(`„${label}" ist jetzt verknüpft.`);
		} catch (e) {
			toast.error(fehlertext(e, "Code konnte nicht bestätigt werden"));
		} finally {
			laeuft = false;
		}
	}

	/** Den Willkommensbildschirm schliessen - ab hier ist die Anwendung dran. */
	function fertig() {
		onboardingOffen.wert = false;
	}

	let appCode = $state("");

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
		hilfeOffen = false;
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
				toast.success("Verbunden. Deine Zeiten werden geladen.");
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

<div class="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 p-4">
	{#if schritt === "start"}
		<!-- Kopf und Fuss stehen ausserhalb der Karte: sie gehoeren zur Seite, nicht
		     zum jeweiligen Schritt. -->
		<header class="flex flex-col items-center gap-4 text-center">
			<img src="/logo.svg" alt="" class="h-16 w-auto drop-shadow-sm" />
			<div class="space-y-1.5">
				<h1 class="text-3xl font-semibold tracking-tight">TimeTracker</h1>
				<p class="text-muted-foreground text-sm text-balance">
					Arbeitszeit erfassen, Berichte schreiben, Feierabend machen.
				</p>
			</div>

			<!-- Drei Zeilen statt eines Absatzes: wer hier landet, ueberfliegt. -->
			<ul class="text-muted-foreground flex flex-col gap-1.5 text-xs">
				<li class="flex items-center gap-2">
					<LockIcon class="size-3.5 shrink-0" />
					Ende-zu-Ende verschlüsselt – der Server sieht nur Chiffrat
				</li>
				<li class="flex items-center gap-2">
					<RefreshCwIcon class="size-3.5 shrink-0" />
					Auf allen Geräten derselbe Stand
				</li>
				<li class="flex items-center gap-2">
					<KeyRoundIcon class="size-3.5 shrink-0" />
					Kein Passwort, keine E-Mail-Pflicht
				</li>
			</ul>
		</header>

		<Card.Root class="w-full">
			<Card.Content class="space-y-5 pt-6">
				{#if vomLink.neu}
					<!-- Der Rechner hat hierher geschickt, ausdruecklich zum Anlegen. Dann
					     ist die Auswahl oben eine Huerde: die Antwort steht schon fest. -->
					<div class="space-y-2">
						<Button size="lg" class="w-full" disabled={laeuft} onclick={() => anlegen(invite)}>
							{laeuft ? "Legt an…" : "Konto anlegen"}
						</Button>
						<p class="text-muted-foreground text-center text-xs">
							Ein Klick, dann fragt dein Gerät nach Fingerabdruck, Gesicht oder PIN.
							{#if vomLink.pair}
								Der Rechner wird gleich mit verknüpft.
							{/if}
						</p>
						<button
							type="button"
							class="text-muted-foreground hover:text-foreground w-full text-xs underline underline-offset-2"
							onclick={() => (vomLink.neu = false)}
						>
							Ich habe doch schon ein Konto
						</button>
					</div>
				{:else}
				<!-- Drei Faelle, alle sichtbar. Vorher stand hier nur die Anmeldung, und
				     wer die App schon auf dem Rechner hatte, fand seinen Weg erst, wenn
				     der Passkey-Dialog vorher fehlgeschlagen war. -->
				<div class="space-y-2">
					<Button size="lg" class="w-full" disabled={laeuft} onclick={anmelden}>
						{laeuft ? "Warte auf Bestätigung…" : "Mit Passkey anmelden"}
					</Button>
					<p class="text-muted-foreground text-center text-xs">
						Wenn du hier schon einmal angemeldet warst. Fingerabdruck, Gesicht oder PIN.
					</p>
				</div>

				{#if hilfeOffen}
					<p class="border-primary/40 bg-muted/40 rounded-md border p-3 text-center text-xs">
						Das hat nicht geklappt. Wähle unten, was auf dich zutrifft.
					</p>
				{/if}

				<div class="flex items-center gap-3">
					<span class="bg-border h-px flex-1"></span>
					<span class="text-muted-foreground text-xs">oder</span>
					<span class="bg-border h-px flex-1"></span>
				</div>

				<!-- Kein Feld fuer den Einladungscode: ob es einen braucht, sagt der
				     Server. Siehe anlegen(). -->
				<div class="space-y-1">
					<Button variant="outline" class="w-full" disabled={laeuft} onclick={() => anlegen(invite)}>
						Ich bin neu – Konto anlegen
					</Button>
					<p class="text-muted-foreground text-center text-xs">
						{#if ausLink}
							Einladung erkannt – du kannst direkt anlegen.
						{:else}
							Legt einen Passkey auf diesem Gerät an. Dauert zehn Sekunden.
						{/if}
					</p>
				</div>

				<!-- Die zwei selteneren Wege, klein. Beide setzen ein Konto voraus, das
				     es schon gibt - gross angeboten waeren sie fuer Neue eine Sackgasse. -->
				<div class="text-muted-foreground flex flex-wrap items-center justify-center gap-x-1 text-xs">
					<button
						type="button"
						class="hover:text-foreground underline underline-offset-2"
						disabled={laeuft}
						onclick={koppelnStarten}
					>
						App auf dem PC verknüpfen
					</button>
					<span aria-hidden="true">·</span>
					<button
						type="button"
						class="hover:text-foreground underline underline-offset-2"
						onclick={() => (phraseOffen = true)}
					>
						Nur noch meine 24 Wörter
					</button>
				</div>
				{/if}

				<div class="text-muted-foreground space-y-2 border-t pt-4 text-center text-xs">
					{#if kopplungscode}
						<!-- Steht ein Code, gehoert er nach vorn: jemand tippt ihn gerade ab. -->
						<PairingCode code={kopplungscode} onCancel={koppelnAbbrechen} />
					{:else if phraseOffen}
						<div class="space-y-2 text-left">
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
									// Mitnehmen, nicht bloss ausblenden: sonst stehen die Woerter
									// beim naechsten Aufklappen wieder sichtbar im Feld.
									phraseEingabe = "";
								}}
							>
								Abbrechen
							</Button>
						</div>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>

		<!-- Der Browser kann alles, die Anwendung kann mehr: Tray, globaler Hotkey,
		     Leerlauf-Erkennung, Autostart. Deshalb ein Angebot, kein Hinweis. -->
		{#if hatDesktopApp(os)}
			<div class="text-center">
				<Button variant="outline" size="sm" href={RELEASES_URL} target="_blank" rel="noreferrer noopener">
					<DownloadIcon class="size-4" /> App für Windows herunterladen
				</Button>
				<p class="text-muted-foreground mt-1 text-xs">
					Mit Tray-Symbol, globalem Kürzel und Leerlauf-Erkennung.
				</p>
			</div>
		{:else if os === "macos" || os === "linux"}
			<p class="text-muted-foreground text-center text-xs">
				Die Desktop-Anwendung gibt es bisher nur für Windows. Im Browser funktioniert
				alles Wesentliche.
			</p>
		{/if}

		<footer class="text-muted-foreground text-center text-xs">
			<a
				href="https://github.com/joe2824/TimeTracker"
				target="_blank"
				rel="noreferrer noopener"
				class="hover:text-foreground underline underline-offset-2"
			>
				Quelltext auf GitHub
			</a>
		</footer>
	{:else if schritt === "geraet"}
		<!-- Der eine Schritt nach dem Anlegen. Vorher stand "Ich nutze die App schon
		     auf dem PC" oben auf dem Startbildschirm - dort ist die Frage falsch:
		     wer noch kein Konto hat, kann gar nichts koppeln. -->
		<header class="flex flex-col items-center gap-3 text-center">
			<img src="/logo.svg" alt="" class="h-14 w-auto drop-shadow-sm" />
			<div class="space-y-1">
				<h1 class="text-2xl font-semibold tracking-tight">Konto steht.</h1>
				<p class="text-muted-foreground text-sm">Eine Sache noch.</p>
			</div>
		</header>

		<Card.Root class="w-full">
			<Card.Content class="space-y-5 pt-6">
				<div class="space-y-2">
					<p class="text-sm font-medium">Hast du TimeTracker schon auf dem Rechner?</p>
					<Label for="appcode" class="text-muted-foreground text-xs font-normal">
						Dann dort unter Einstellungen → Konto den Kopplungscode anzeigen lassen und hier
						eintragen.
					</Label>
					<div class="flex gap-2">
						<Input
							id="appcode"
							bind:value={appCode}
							placeholder="ABCD-EFGH-JKLM"
							maxlength={14}
							class="font-mono tracking-wider uppercase"
							onkeydown={(e) => e.key === "Enter" && appDazuholen()}
						/>
						<Button disabled={laeuft || !appCode.trim()} onclick={appDazuholen}>
							{laeuft ? "…" : "Verknüpfen"}
						</Button>
					</div>
				</div>

				<div class="flex items-center gap-3">
					<span class="bg-border h-px flex-1"></span>
					<span class="text-muted-foreground text-xs">oder</span>
					<span class="bg-border h-px flex-1"></span>
				</div>

				{#if hatDesktopApp(os)}
					<div class="space-y-1">
						<Button
							variant="outline"
							class="w-full"
							href={RELEASES_URL}
							target="_blank"
							rel="noreferrer noopener"
						>
							<DownloadIcon class="size-4" /> App für Windows herunterladen
						</Button>
						<p class="text-muted-foreground text-center text-xs">
							Tray-Symbol, globales Kürzel, Leerlauf-Erkennung. Verknüpfen kannst du sie
							später jederzeit.
						</p>
					</div>
				{:else}
					<p class="text-muted-foreground text-center text-xs">
						Die Desktop-Anwendung gibt es bisher nur für Windows. Im Browser funktioniert
						alles Wesentliche.
					</p>
				{/if}

				<Button variant="ghost" class="w-full" onclick={fertig}>Weiter zur App</Button>
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

<!-- Erst wenn der Server einen verlangt. Siehe anlegen(). -->
<Dialog.Root open={inviteOffen} onOpenChange={(o) => (inviteOffen = o)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Einladungscode</Dialog.Title>
			<Dialog.Description>
				Dieser Server nimmt keine offenen Registrierungen an. Wer ihn betreibt, kann dir
				einen Code ausstellen.
			</Dialog.Description>
		</Dialog.Header>
		<Input
			bind:value={invite}
			placeholder="ABCD-EFGH-JKLM-NPQR"
			class="font-mono tracking-wider uppercase"
			onkeydown={(e) => e.key === "Enter" && anlegen(invite)}
		/>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (inviteOffen = false)}>Abbrechen</Button>
			<Button disabled={laeuft || !invite.trim()} onclick={() => anlegen(invite)}>
				{laeuft ? "Legt an…" : "Konto anlegen"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
