<script lang="ts">
	// Der erste Bildschirm im Browser: anmelden oder Konto anlegen.
	//
	// Der Startschritt ist zugleich die oeffentliche Seite - Landing traegt sie,
	// die Anmeldekarte reicht diese Komponente als Snippet hinein.
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Checkbox } from "$lib/components/ui/checkbox";
	import * as Card from "$lib/components/ui/card";
	import { toast } from "svelte-sonner";
	import { account } from "$lib/sync/account.svelte";
	import { app } from "$lib/app.svelte";
	import { ApiError, addPasskeyWrap, login, register, unlockWithPhrase } from "$lib/sync/enroll";
	import * as Dialog from "$lib/components/ui/dialog";
	import PairingCode from "$lib/components/onboarding/PairingCode.svelte";
	import Landing from "$lib/components/onboarding/Landing.svelte";
	import DownloadIcon from "@lucide/svelte/icons/download";
	import FingerprintIcon from "@lucide/svelte/icons/fingerprint";
	import UserPlusIcon from "@lucide/svelte/icons/user-plus";
	import KeyRoundIcon from "@lucide/svelte/icons/key-round";
	import { RELEASES_URL, erkenneOS, hatDesktopApp } from "$lib/platform/os";
	import { errorText, logWarn } from "$lib/log";
	import { linkParameter } from "$lib/invite";
	import { onboardingOffen } from "$lib/onboarding.svelte";
	import {
		isPairingCode,
		isValidRecoveryPhrase,
		normalizePairingCode
	} from "$lib/crypto/vault";

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
				// Begruesst wird mit dem Namen aus "Bericht & E-Mail" - der steht hier auf
				// dem Geraet und ist der, den die Person selbst gesetzt hat. Ist er leer,
				// bleibt der Gruss namenlos statt auf die Kontokennung auszuweichen.
				const name = app.settings.senderName.trim();
				toast.success(name ? `Willkommen zurück, ${name}.` : "Willkommen zurück.");
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
	 * Der Kopplungscode, den der Link mitgebracht hat - zum Bestaetigen, nicht
	 * bestaetigt.
	 *
	 * Er wird ausdruecklich NICHT von allein durchgewinkt. Wer den Link geschickt
	 * hat, muss nicht der sein, dem der Rechner gehoert: ein untergeschobenes
	 * `?pair=` verpackte sonst still den Tresorschluessel fuer ein fremdes Geraet,
	 * und der Link waere aus der Adresszeile schon wieder verschwunden. Der Code
	 * landet deshalb nur im Feld. Bestaetigt wird er von Hand - nachdem jemand ihn
	 * mit dem Bildschirm des Rechners verglichen hat, der wirklich dazusoll.
	 */

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
			// Ohne expliziten Namen setzt der Server die Kontokennung ein;
			// der Nutzer kann später in den Einstellungen seinen Namen vergeben.
			const r = await register(serverUrl, "", {
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
		onboardingOffen.value = true;
		await account.linkWithSession(serverUrl, schluessel, angemeldeterName);

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
			onboardingOffen.value = false;
			app.dismissOnboarding();
			toast.success(`„${label}" ist jetzt verknüpft.`);
		} catch (e) {
			toast.error(fehlertext(e, "Code konnte nicht bestätigt werden"));
		} finally {
			laeuft = false;
		}
	}

	/** Den Willkommensbildschirm schliessen und das Onboarding zur Ersteinrichtung öffnen. */
	function fertig() {
		onboardingOffen.value = false;
		app.openOnboarding();
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

	/** Steht der Kopplungs-Dialog offen? */
	let koppelnOffen = $state(false);

	async function koppelnStarten() {
		hilfeOffen = false;
		laeuft = true;
		// Vor dem Holen aufmachen. Der Server braucht einen Moment, und ein Klick,
		// nach dem sichtbar nichts passiert, sieht aus wie ein kaputter Knopf.
		koppelnOffen = true;
		try {
			kopplungscode = await account.startPairing(serverUrl, "Browser");
			// Alle zwei Sekunden nachsehen. Der Server bremst das nicht aus - gezaehlt
			// werden dort nur Fehlgriffe, nicht das Warten.
			poll = setInterval(pruefen, 2000);
		} catch (e) {
			// Ohne Code hat der Dialog nichts zu zeigen.
			koppelnOffen = false;
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
		koppelnOffen = false;
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

{#if schritt === "start"}
	<!-- Der Startschritt IST die Landing Page: Werbung und Anmeldung auf einer
	     Seite. Landing traegt nur die Seite, die Karte kommt als Snippet von
	     hier - der Tresorschluessel hat in einer Marketingkomponente nichts zu
	     suchen. -->
	<Landing {os}>
		{#snippet auth()}
			<Card.Root class="w-full shadow-md border-border/80 bg-card">
				<Card.Header class="pb-3 border-b">
					<Card.Title class="text-base font-semibold tracking-tight">
						{vomLink.neu ? "Konto anlegen" : "Loslegen"}
					</Card.Title>
					<Card.Description class="text-xs leading-relaxed">
						{#if vomLink.neu}
							Erstelle dein Konto per Touch ID, Face ID oder PIN. Ganz ohne Passwort.
						{:else}
							Schnell & sicher per Passkey (Fingerabdruck, Face ID oder PIN).
						{/if}
					</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-4 pt-4">
					{#if vomLink.neu}
						<!-- Der Rechner hat hierher geschickt, ausdruecklich zum Anlegen. -->
						<div class="space-y-2.5">
							<Button size="lg" class="w-full h-11 font-medium gap-2 shadow-xs" disabled={laeuft} onclick={() => anlegen(invite)}>
								<KeyRoundIcon class="size-4.5" />
								<span>{laeuft ? "Legt an…" : "Konto anlegen"}</span>
							</Button>
							<button
								type="button"
								class="text-muted-foreground hover:text-foreground w-full text-center text-xs underline underline-offset-4 pt-1"
								onclick={() => (vomLink.neu = false)}
							>
								Ich habe bereits ein Konto
							</button>
						</div>
					{:else}
						<!-- Login & Registrieren fokussiert und ohne Textwüsten -->
						<div class="space-y-2.5">
							<Button
								size="lg"
								class="w-full h-11 text-sm font-medium gap-2 shadow-xs transition-all active:scale-[0.99]"
								disabled={laeuft}
								onclick={anmelden}
							>
								<FingerprintIcon class="size-4.5" />
								<span>{laeuft ? "Logge ein…" : "Login mit Passkey"}</span>
							</Button>
						</div>

						{#if hilfeOffen}
							<div class="border-primary/30 bg-primary/5 rounded-lg border p-2.5 text-center text-xs text-foreground animate-in fade-in-0 duration-150">
								<p class="font-medium">Kein Passkey gefunden?</p>
								<p class="text-muted-foreground mt-0.5">Erstelle unten ein neues Konto oder koppele ein bestehendes Gerät.</p>
							</div>
						{/if}

						<div class="relative flex items-center justify-center my-1">
							<span class="bg-border h-px w-full"></span>
							<span class="bg-card px-2.5 text-[11px] text-muted-foreground uppercase tracking-wider font-medium">oder</span>
						</div>

						<!-- Neues Konto erstellen -->
						<Button
							variant="outline"
							class="w-full h-10 text-sm font-medium gap-2 hover:bg-accent/60 transition-colors"
							disabled={laeuft}
							onclick={() => anlegen(invite)}
						>
							<UserPlusIcon class="size-4" />
							<span>{laeuft ? "Erstelle Konto…" : (ausLink ? "Mit Einladung registrieren" : "Neues Konto erstellen")}</span>
						</Button>

						<!-- Die zwei selteneren Wege, klein und sauber zentriert -->
						<div class="text-muted-foreground border-t pt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs">
							<button
								type="button"
								class="hover:text-foreground transition-colors underline-offset-4 hover:underline"
								disabled={laeuft}
								onclick={koppelnStarten}
							>
								Gerät koppeln
							</button>
							<span aria-hidden="true" class="text-border">•</span>
							<button
								type="button"
								class="hover:text-foreground transition-colors underline-offset-4 hover:underline"
								onclick={() => (phraseOffen = true)}
							>
								Wiederherstellen
							</button>
						</div>
					{/if}
				</Card.Content>
			</Card.Root>
		{/snippet}
	</Landing>
{:else}
	<!-- Die Schritte NACH dem Anlegen. -->
	<div
		class="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
	>
		{#if schritt === "geraet"}
			<!-- Der eine Schritt nach dem Anlegen. -->
			<header class="flex flex-col items-center gap-3 text-center">
				<img src="/logo.svg" alt="" class="h-14 w-auto drop-shadow-sm" />
				<div class="space-y-1">
					<h1 class="text-2xl font-semibold tracking-tight">Erfolgreich registriert!</h1>
					<p class="text-muted-foreground text-sm">Fast geschafft.</p>
				</div>
			</header>

			<Card.Root class="w-full">
				<Card.Content class="space-y-5 pt-6">
					<div class="space-y-2">
						<p class="text-sm font-medium">Nutzt du TimeTracker bereits auf deinem PC?</p>
						<!-- Der Code steht drueben auf dem Bildschirm und wird hier abgetippt.
						     Genau dieses Abtippen ist die Pruefung: es gibt keinen Weg, auf dem
						     ein fremder Code unbemerkt in dieses Feld kaeme. -->
						<Label for="appcode" class="text-muted-foreground text-xs font-normal">
							Gib hier den 12-stelligen Kopplungscode aus der Windows-App (unter Einstellungen → Konto) ein, um die Geräte zu synchronisieren.
							
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
								<DownloadIcon class="size-4" /> Download für Windows
							</Button>
							<p class="text-muted-foreground text-center text-xs">
								Inklusive Tray-Icon, globalen Hotkeys und automatischer Leerlauf-Erkennung. Du kannst deine Geräte auch später noch koppeln.
								
							</p>
						</div>
					{:else}
						<p class="text-muted-foreground text-center text-xs">
							Aktuell gibt es die Desktop-App nur für Windows. Alle wichtigen Funktionen stehen dir aber direkt hier im Browser zur Verfügung.
							
						</p>
					{/if}

					<Button variant="ghost" class="w-full" onclick={fertig}>Direkt im Browser einrichten</Button>
				</Card.Content>
			</Card.Root>

		{:else if schritt === "phrase"}
			<Card.Root class="w-full">
				<Card.Header>
					<Card.Title>Recovery-Phrase sichern</Card.Title>
					<Card.Description>
						Diese 24 Wörter sind dein einziges Backup, falls du den Zugriff auf deine Geräte verlierst.
						Speichere sie sicher ab. <strong>Wir zeigen diese Wörter nur jetzt an</strong>.
						Wir können sie später nicht für dich wiederherstellen.
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
						<p
							class="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300"
						>
							Dein Browser unterstützt leider keine automatische Tresor-Entschlüsselung (PRF).
							Du wirst diese Recovery-Phrase daher bei jedem Login auf diesem Gerät eingeben müssen.
							
						</p>
					{/if}

					<Label
						for="phrase-ok"
						class="bg-muted/40 items-start gap-2.5 rounded-lg p-3 text-sm leading-relaxed font-normal"
					>
						<Checkbox id="phrase-ok" bind:checked={bestaetigt} class="mt-0.5" />
						<span>
							Ich habe die 24 Wörter sicher notiert. Mir ist bewusst, dass bei einem Verlust dieser Phrase
							auch meine Daten unwiederbringlich verloren sind.
						</span>
					</Label>

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
						Bitte gib deine 24 Wörter ein, um deinen lokalen Daten-Tresor zu entschlüsseln.
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
{/if}

<!--
	Der Kopplungscode.

	Auch als Dialog: der Code wird von einem Bildschirm auf einen anderen
	abgetippt, und dabei soll er gross und mittig stehen, statt unten aus der
	Karte zu ragen.
-->
<Dialog.Root
	open={koppelnOffen}
	onOpenChange={(o) => {
		koppelnOffen = o;
		// Zuklappen heisst abbrechen - sonst liefe die Abfrage im Hintergrund
		// weiter und der Vorgang bliebe auf dem Server stehen.
		if (!o) koppelnAbbrechen();
	}}
>
	<!-- max-w-md, nicht -sm: der Code ist 14 Zeichen weit gesperrt und braucht
	     mitsamt Innenabstaenden 422 px. Bei 384 px brach er nach "PT8F-" um, und
	     ein Code, der mitten in der Kette umbricht, wird beim Abtippen falsch. -->
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Bestehendes Konto koppeln</Dialog.Title>
			<Dialog.Description>
				Dieser Browser ist noch mit keinem Konto verknüpft. Gib den folgenden Code in deiner TimeTracker App ein, um ihn zu autorisieren.
			</Dialog.Description>
		</Dialog.Header>

		{#if kopplungscode}
			<!-- Ohne onCancel: das Abbrechen steht unten im Fuss des Dialogs, und
			     zweimal derselbe Knopf untereinander stiftet nur Verwirrung. -->
			<PairingCode code={kopplungscode} />
		{:else}
			<p class="text-muted-foreground py-8 text-center text-sm">Lade Code...</p>
		{/if}

		<Dialog.Footer>
			<Button variant="outline" onclick={koppelnAbbrechen}>Abbrechen</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!--
	Die 24 Woerter.

	Als Dialog und nicht als aufklappender Block in der Karte: der Block wuchs
	nach unten aus dem Bild heraus, sobald das Fenster keine 700 px hoch war -
	der Absende-Knopf stand dann unter der Kante, und der Klick sah aus, als
	haette er nichts getan.
-->
<Dialog.Root
	open={phraseOffen}
	onOpenChange={(o) => {
		phraseOffen = o;
		// Beim Schliessen mitnehmen, nicht bloss ausblenden: sonst stehen die
		// Woerter beim naechsten Oeffnen wieder sichtbar im Feld.
		if (!o) phraseEingabe = "";
	}}
>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Konto wiederherstellen</Dialog.Title>
			<Dialog.Description>
				Falls du dein primäres Gerät verloren hast, kannst du hier deinen Account
				mit deiner 24-Wörter-Phrase wiederherstellen.
			</Dialog.Description>
		</Dialog.Header>
		<textarea
			bind:value={phraseEingabe}
			rows="3"
			class="border-input bg-background w-full rounded-md border p-2 font-mono text-sm"
			placeholder="wort eins wort zwei wort drei …"
		></textarea>
		<Dialog.Footer>
			<Button variant="outline" disabled={laeuft} onclick={() => (phraseOffen = false)}>
				Abbrechen
			</Button>
			<Button disabled={laeuft || !phraseEingabe.trim()} onclick={zurueckholen}>
				{laeuft ? "Einen Moment…" : "Wiederherstellen"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Erst wenn der Server einen verlangt. Siehe anlegen(). -->
<Dialog.Root open={inviteOffen} onOpenChange={(o) => (inviteOffen = o)}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Einladungscode</Dialog.Title>
			<Dialog.Description>
				Dieser Server erlaubt keine öffentliche Registrierung.
				Bitte gib deinen Einladungscode ein.
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
