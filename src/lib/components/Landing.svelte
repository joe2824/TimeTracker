<script lang="ts">
	// Die oeffentliche Seite: was TimeTracker ist, bevor jemand ein Konto hat.
	//
	// Sie traegt bewusst KEINE Anmeldelogik. Die Karte im Kopfbereich kommt als
	// Snippet aus WebOnboarding herein - dort liegt der Zustand (Passkey, Phrase,
	// Kopplung), hier nur die Seite drumherum. Sonst haette eine Marketingseite
	// Zugriff auf den Tresorschluessel, und beim Umbauen der Optik waere jedes Mal
	// die Anmeldung mit im Spiel.
	import type { Snippet } from "svelte";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import GithubIcon from "$lib/components/icons/GithubIcon.svelte";
	import { toast } from "svelte-sonner";
	import {
		IMAGE_REF,
		RELEASES_URL,
		REPO_URL,
		WIKI_URL,
		hatDesktopApp,
		type Betriebssystem
	} from "$lib/platform/os";

	import TimerIcon from "@lucide/svelte/icons/timer";
	import MailIcon from "@lucide/svelte/icons/mail";
	import FileSpreadsheetIcon from "@lucide/svelte/icons/file-spreadsheet";
	import CoffeeIcon from "@lucide/svelte/icons/coffee";
	import ChartColumnIcon from "@lucide/svelte/icons/chart-column";
	import KeyboardIcon from "@lucide/svelte/icons/keyboard";
	import LockIcon from "@lucide/svelte/icons/lock";
	import KeyRoundIcon from "@lucide/svelte/icons/key-round";
	import ServerIcon from "@lucide/svelte/icons/server";
	import DownloadIcon from "@lucide/svelte/icons/download";
	import MonitorIcon from "@lucide/svelte/icons/monitor";
	import GlobeIcon from "@lucide/svelte/icons/globe";
	import CheckIcon from "@lucide/svelte/icons/check";
	import CopyIcon from "@lucide/svelte/icons/copy";
	import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
	import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
	import ScanEyeIcon from "@lucide/svelte/icons/scan-eye";
	import BookOpenIcon from "@lucide/svelte/icons/book-open";

	let { auth, os }: { auth: Snippet; os: Betriebssystem } = $props();

	// $derived und nicht const: `os` ist eine Eigenschaft, und eine einmal
	// gelesene Eigenschaft bliebe auf ihrem ersten Wert stehen.
	const desktop = $derived(hatDesktopApp(os));

	/**
	 * Was dieses Geraet WIRKLICH bekommt.
	 *
	 * Gebaut wird bisher nur fuer Windows (siehe release.yml). Ueberall sonst ist
	 * der Browser nicht der Trostpreis, sondern der Weg - deshalb steht dort die
	 * PWA gross und der Windows-Installer in der Liste darunter.
	 */
	const hauptweg = $derived(desktop ? "windows" : "browser");

	const funktionen = [
		{
			icon: TimerIcon,
			titel: "Timer",
			text: "Aktivität anklicken und der Timer läuft. Nochmal klicken und er steht. Unter „Heute“ siehst du, was bisher zusammengekommen ist."
		},
		{
			icon: MailIcon,
			titel: "Monatsbericht",
			text: "Am Monatsende stehen die Stunden je Aktivität fertig da, auf Wunsch gerundet. Du kopierst sie als HTML raus oder lässt dir einen Outlook-Entwurf bauen."
		},
		{
			icon: FileSpreadsheetIcon,
			titel: "Stundenabgleich",
			text: "Zieh den Stundenreport deiner Firma als .xlsx hinein. TimeTracker zeigt dir die Tage, an denen Zeit fehlt, und du ordnest die Lücken in einem Rutsch zu."
		},
		{
			icon: CoffeeIcon,
			titel: "Pausen",
			text: "Pausen zieht TimeTracker automatisch ab. Wenn bei euch andere Regeln gelten, schaltest du das aus und trägst sie selbst ein."
		},
		{
			icon: ChartColumnIcon,
			titel: "Auswertung",
			text: "Soll/Ist-Saldo, Stunden je Aktivität und eine Heatmap übers Jahr. Das bleibt auf deinem Gerät und steht in keinem Bericht."
		},
		{
			icon: KeyboardIcon,
			titel: "Tastenkürzel",
			text: "Strg+K öffnet die Befehlspalette. Ein globales Kürzel startet und stoppt den letzten Timer, auch wenn das Fenster hinten liegt."
		}
	];

	/** Der gefälschte Tag in der Vorschau. Plausibel, nicht echt. */
	const vorschau = [
		{ name: "Projekt Kolibri", von: "09:02", bis: "11:30", dauer: "2:28", laeuft: false },
		{ name: "Support", von: "11:30", bis: "12:15", dauer: "0:45", laeuft: false },
		{ name: "Projekt Kolibri", von: "13:00", bis: "jetzt", dauer: "2:59", laeuft: true }
	];

	async function befehlKopieren() {
		try {
			await navigator.clipboard.writeText(`docker pull ${IMAGE_REF}`);
			toast.success("Befehl kopiert.");
		} catch {
			toast.error("Kopieren nicht möglich – bitte abschreiben.");
		}
	}
</script>

<div class="min-h-dvh">
	<!-- ---------- Kopfzeile ---------- -->
	<header
		class="bg-background/80 supports-backdrop-filter:bg-background/60 sticky top-0 z-40 border-b pt-[env(safe-area-inset-top)] backdrop-blur"
	>
		<div class="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
			<a href="#oben" class="flex items-center gap-2 font-semibold tracking-tight">
				<img src="/logo.svg" alt="" class="size-7" />
				TimeTracker
			</a>

			<!-- Auf schmalen Displays weg: drei Sprungmarken neben Logo und zwei
			     Knoepfen gehen sich dort nicht aus, und gescrollt wird ohnehin. -->
			<nav class="text-muted-foreground ml-4 hidden items-center gap-5 text-sm md:flex">
				<a class="hover:text-foreground transition-colors" href="#funktionen">Funktionen</a>
				<a class="hover:text-foreground transition-colors" href="#sicherheit">Sicherheit</a>
				<a class="hover:text-foreground transition-colors" href="#selbst-hosten">Selbst hosten</a>
				<a
					class="hover:text-foreground flex items-center gap-1.5 transition-colors"
					href={WIKI_URL}
					target="_blank"
					rel="noreferrer noopener"
				>
					<BookOpenIcon class="size-3.5" /> Wiki
				</a>
			</nav>

			<div class="ml-auto flex items-center gap-1.5 sm:gap-2">
				<Button
					variant="outline"
					size="sm"
					href="#download"
					class="gap-1.5 font-medium border-primary/30 bg-primary/4 hover:bg-primary/8 hover:border-primary/50 transition-colors shadow-xs"
				>
					<DownloadIcon class="size-3.5 text-primary" />
					<span>{desktop ? "Download" : "Windows-App"}</span>
				</Button>
				<Button size="sm" href="#anmelden" class="font-medium gap-1.5 shadow-sm">
					<KeyRoundIcon class="size-3.5" />
					<span>Anmelden</span>
				</Button>
				<Button
					variant="ghost"
					size="icon"
					href={REPO_URL}
					target="_blank"
					rel="noreferrer noopener"
					aria-label="Quelltext auf GitHub"
					class="hidden sm:inline-flex"
				>
					<GithubIcon class="size-4" />
				</Button>
			</div>
		</div>
	</header>

	<!-- ---------- Kopfbereich ---------- -->
	<section id="oben" class="relative overflow-hidden border-b">
		<!-- Ein Raster, das nach aussen ausblendet. Rein dekorativ: aria-hidden,
		     pointer-events-none, damit es weder vorgelesen wird noch Klicks frisst. -->
		<div
			aria-hidden="true"
			class="pointer-events-none absolute inset-0 mask-[radial-gradient(60%_50%_at_50%_0%,black,transparent)]"
			style="background-image:linear-gradient(to right,var(--border) 1px,transparent 1px),linear-gradient(to bottom,var(--border) 1px,transparent 1px);background-size:56px 56px"
		></div>

		<div
			class="relative mx-auto grid max-w-6xl gap-8 px-4 py-8 sm:px-6 sm:py-16 lg:grid-cols-[1.05fr_minmax(0,26rem)] lg:items-start lg:gap-16"
		>
			<!-- 1. Intro & Titel: Auf Desktop links, auf Mobile direkt oben -->
			<div class="flex flex-col items-start gap-4 sm:gap-6 lg:col-start-1 lg:row-start-1">
				<Badge variant="outline" class="h-6 gap-1.5 px-2.5">
					<LockIcon class="size-3" />
					Open Source, verschlüsselt
				</Badge>

				<h1 class="text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
					Projektzeiten erfassen und am Monatsende abschicken
				</h1>

				<p class="text-muted-foreground max-w-prose text-sm leading-relaxed text-pretty sm:text-lg">
					TimeTracker läuft nebenbei im Tray oder im Browser. Du klickst auf eine Aktivität, der Timer läuft.
					Am Monatsende hast du die Stunden je Projekt beisammen und schickst sie deiner
					Chefin oder deinem Chef als Mail. Was dabei auf dem Server landet, ist
					verschlüsselt.
				</p>
			</div>

			<!-- 2. Die Anmeldung: Auf Mobile DIREKT unter der Überschrift, auf Desktop rechts -->
			<div id="anmelden" class="w-full scroll-mt-20 lg:col-start-2 lg:row-span-2 lg:row-start-1">
				{@render auth()}
			</div>

			<!-- 3. Details, Checkliste & Buttons: Auf Mobile unter der Anmeldung, auf Desktop links unten -->
			<div class="flex flex-col items-start gap-6 lg:col-start-1 lg:row-start-2">
				<ul class="grid gap-2.5 text-sm sm:grid-cols-2">
					{#each ["Anmelden per Passkey", "Keine E-Mail nötig", "Eigener Server möglich", "Windows-App und Browser"] as punkt (punkt)}
						<li class="flex items-center gap-2">
							<CheckIcon class="size-4 shrink-0" />
							<span class="text-muted-foreground">{punkt}</span>
						</li>
					{/each}
				</ul>

				<div class="flex flex-wrap items-center gap-2 pt-1">
					{#if desktop}
						<Button
							variant="outline"
							class="h-10 gap-2 px-4"
							href={RELEASES_URL}
							target="_blank"
							rel="noreferrer noopener"
						>
							<DownloadIcon class="size-4" /> Für Windows herunterladen
						</Button>
					{:else}
						<Button
							variant="outline"
							class="h-10 gap-2 px-4"
							href={RELEASES_URL}
							target="_blank"
							rel="noreferrer noopener"
						>
							<DownloadIcon class="size-4" /> Windows-Download
						</Button>
						<Button variant="outline" class="h-10 gap-2 px-4" href="#funktionen">
							Funktionen ansehen
						</Button>
					{/if}
					<Button
						variant="ghost"
						class="h-10 gap-2 px-4"
						href={REPO_URL}
						target="_blank"
						rel="noreferrer noopener"
					>
						<GithubIcon class="size-4" /> Quelltext ansehen
					</Button>
				</div>

				{#if os === "macos"}
					<p class="text-muted-foreground text-xs">
						<span class="font-medium text-foreground">Hinweis für Mac-Nutzer:</span> Eine native macOS-App wird aktuell nicht unterstützt. Auf dem Mac läuft TimeTracker direkt als Web-App im Browser oder installierte PWA.
					</p>
				{:else if !desktop && os !== "mobil"}
					<p class="text-muted-foreground text-xs">
						<span class="font-medium text-foreground">Hinweis:</span> Die native Desktop-App ist für Windows verfügbar. Auf anderen Systemen läuft TimeTracker direkt im Browser.
					</p>
				{/if}
			</div>
		</div>
	</section>

	<!-- ---------- Wie ein Tag aussieht ---------- -->
	<section class="border-b">
		<div class="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
			<div class="mb-8 max-w-2xl">
				<h2 class="text-2xl font-semibold tracking-tight sm:text-3xl">So sieht ein Tag aus</h2>
				<p class="text-muted-foreground mt-2 text-sm sm:text-base">
					Links die Aktivität, rechts die Zeit. Unten steht, was unterm Strich übrig bleibt.
				</p>
			</div>

			<!-- Nachbau der „Heute“-Ansicht, nicht ihr Abbild: ein Bildschirmfoto
			     veraltet still, sobald sich die Oberflaeche aendert. Die Zahlen sind
			     erfunden und ergeben zusammen, was unten steht. -->
			<div class="bg-card rounded-xl border shadow-sm">
				<div class="flex items-center justify-between border-b px-4 py-3 sm:px-5">
					<div class="flex items-center gap-2 text-sm font-medium">
						<TimerIcon class="size-4" /> Heute
					</div>
					<span class="text-muted-foreground font-mono text-sm tabular-nums">6:12 h</span>
				</div>

				<ul class="divide-y">
					{#each vorschau as e (e.von)}
						<li class="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-3 sm:px-5">
							<span
								class="size-2 rounded-full {e.laeuft
									? 'bg-foreground animate-pulse'
									: 'bg-muted-foreground/40'}"
							></span>
							<span class="truncate text-sm">{e.name}</span>
							<span class="text-muted-foreground font-mono text-xs tabular-nums sm:text-sm">
								{e.von} – {e.bis}
								<span class="text-foreground ml-2 font-medium">{e.dauer}</span>
							</span>
						</li>
					{/each}
				</ul>

				<div
					class="text-muted-foreground bg-muted/40 flex flex-wrap gap-x-5 gap-y-1 rounded-b-xl border-t px-4 py-3 text-xs sm:px-5"
				>
					<span>erfasst <span class="text-foreground font-mono">6:12</span></span>
					<span>Pausenabzug <span class="text-foreground font-mono">−0:45</span></span>
					<span>Arbeitszeit <span class="text-foreground font-mono">5:27</span></span>
				</div>
			</div>
		</div>
	</section>

	<!-- ---------- Funktionen ---------- -->
	<section id="funktionen" class="scroll-mt-20 border-b">
		<div class="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
			<div class="mb-10 max-w-2xl">
				<h2 class="text-2xl font-semibold tracking-tight sm:text-3xl">Was drin ist</h2>
				<p class="text-muted-foreground mt-2 text-sm sm:text-base">
					Genug, um die Stunden über den Monat zu bekommen, ohne nebenher eine Tabelle zu pflegen.
				</p>
			</div>

			<div class="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 lg:grid-cols-3">
				{#each funktionen as f (f.titel)}
					{@const Symbol = f.icon}
					<div class="bg-background flex flex-col gap-3 p-5 sm:p-6">
						<span class="bg-muted flex size-9 items-center justify-center rounded-lg">
							<Symbol class="size-4.5" />
						</span>
						<h3 class="font-medium">{f.titel}</h3>
						<p class="text-muted-foreground text-sm leading-relaxed">{f.text}</p>
					</div>
				{/each}
			</div>
		</div>
	</section>

	<!-- ---------- Sicherheit ---------- -->
	<section id="sicherheit" class="scroll-mt-20 border-b">
		<div class="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
			<div class="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
				<div>
					<h2 class="text-2xl font-semibold tracking-tight sm:text-3xl">
						Was auf dem Server liegt, ist verschlüsselt
					</h2>
					<p class="text-muted-foreground mt-3 text-sm leading-relaxed sm:text-base">
						Ver- und entschlüsselt wird auf deinem Gerät. Auf dem Server liegen nur
						verschlüsselte Daten, lesen kann er sie nicht. Das gilt auch dann, wenn der Server
						dir selbst gehört.
					</p>
					<p class="text-muted-foreground mt-3 text-sm leading-relaxed sm:text-base">
						Den Schlüssel dazu öffnet dein Passkey. Solltest du mal alle Geräte verlieren,
						kommst du mit 24 Wörtern wieder an deine Daten. Die siehst du einmal beim Anlegen,
						danach nie wieder, und der Server kennt sie nicht.
					</p>
				</div>

				<div class="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-1">
					{#each [{ icon: LockIcon, titel: "Verschlüsselt unterwegs und gespeichert", text: "Zeiten, Aktivitäten und Einstellungen verlassen dein Gerät nur verschlüsselt." }, { icon: KeyRoundIcon, titel: "Anmelden ohne Passwort", text: "Passkey heißt Fingerabdruck, Gesicht oder die PIN deines Geräts. Eine E-Mail-Adresse musst du nicht angeben." }, { icon: RefreshCwIcon, titel: "Überall derselbe Stand", text: "Rechner, Notebook, Handy. Ein neues Gerät kommt über einen Kopplungscode dazu, den du bestätigen musst." }, { icon: ScanEyeIcon, titel: "Auswertung bleibt bei dir", text: "Saldo, Heatmap und der Arbeitszeit-Check laufen auf deinem Gerät. Davon landet nichts im Monatsbericht." }] as s (s.titel)}
						{@const Symbol = s.icon}
						<div class="bg-background flex items-start gap-4 p-5">
							<span class="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
								<Symbol class="size-4.5" />
							</span>
							<div class="space-y-1">
								<h3 class="text-sm font-medium">{s.titel}</h3>
								<p class="text-muted-foreground text-sm leading-relaxed">{s.text}</p>
							</div>
						</div>
					{/each}
				</div>
			</div>
		</div>
	</section>

	<!-- ---------- Download ---------- -->
	<section id="download" class="scroll-mt-20 border-b">
		<div class="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
			<div class="mb-10 max-w-2xl">
				<h2 class="text-2xl font-semibold tracking-tight sm:text-3xl">Wo es läuft</h2>
				<p class="text-muted-foreground mt-2 text-sm sm:text-base">
					{#if os === "windows"}
						Du bist auf Windows. Dafür gibt es die Desktop-Anwendung mit Tray-Symbol und Autostart.
					{:else if os === "macos"}
						Du bist auf einem Mac. Eine native macOS-App wird aktuell nicht unterstützt – auf dem Mac läuft TimeTracker direkt als vollwertige Web-App im Browser oder als PWA.
					{:else}
						Die native Desktop-Anwendung gibt es für Windows. Im Browser kannst du TimeTracker auf jedem System als vollwertige Web-App nutzen.
					{/if}
				</p>
			</div>

			<div class="bg-card rounded-xl border p-6 shadow-sm sm:p-8">
				<div class="grid gap-6 md:grid-cols-2">
					<!-- Windows Desktop-App Box -->
					<div class="bg-background flex flex-col justify-between gap-4 rounded-lg border p-5">
						<div class="space-y-2">
							<div class="flex items-center gap-2.5">
								<span class="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
									<MonitorIcon class="size-5" />
								</span>
								<div>
									<h3 class="font-medium">TimeTracker für Windows</h3>
									<Badge variant="outline" class="text-[10px] px-1.5 py-0 h-4">Native Desktop-App</Badge>
								</div>
							</div>
							<p class="text-muted-foreground text-xs leading-relaxed">
								Sitzt im Tray, startet mit Windows, globale Tastenkürzel und automatische Updates.
							</p>
						</div>
						<Button
							class="w-full gap-2 sm:w-auto self-start"
							href={RELEASES_URL}
							target="_blank"
							rel="noreferrer noopener"
						>
							<DownloadIcon class="size-4" /> Windows-Installer (.exe)
						</Button>
					</div>

					<!-- Browser / Mac / Mobile Box -->
					<div class="bg-background flex flex-col justify-between gap-4 rounded-lg border p-5">
						<div class="space-y-2">
							<div class="flex items-center gap-2.5">
								<span class="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
									<GlobeIcon class="size-5" />
								</span>
								<div>
									<h3 class="font-medium">Web-App (Mac, Linux & Mobile)</h3>
									<Badge variant="outline" class="text-[10px] px-1.5 py-0 h-4">Browser & PWA</Badge>
								</div>
							</div>
							<p class="text-muted-foreground text-xs leading-relaxed">
								{#if os === "macos"}
									Auf dem Mac einfach oben anmelden. Über Safari („Zum Dock hinzufügen“) oder Chrome („App installieren“) als eigenes Fenster ohne Adressleiste nutzbar.
								{:else}
									Volle Funktionalität ohne Installation direkt im Browser. Lässt sich auch als App auf den Startbildschirm ablegen.
								{/if}
							</p>
						</div>
						<Button variant="outline" class="w-full gap-2 sm:w-auto self-start" href="#anmelden">
							<KeyRoundIcon class="size-4" /> Jetzt im Browser öffnen
						</Button>
					</div>
				</div>

				<div class="mt-6 flex items-start gap-3 rounded-lg border bg-muted/40 p-4">
					<ServerIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
					<p class="text-muted-foreground text-xs leading-relaxed">
						<span class="text-foreground font-medium">Eigener Server:</span> Ein einzelner Docker-Container synchronisiert deine Daten E2E-verschlüsselt zwischen Windows-PC, Mac und Smartphone.
						<a class="hover:text-foreground underline underline-offset-2 ml-1" href="#selbst-hosten">So geht das</a>
					</p>
				</div>
			</div>
		</div>
	</section>

	<!-- ---------- Selbst hosten ---------- -->
	<section id="selbst-hosten" class="scroll-mt-20 border-b">
		<div class="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
			<div class="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-center lg:gap-16">
				<div>
					<h2 class="text-2xl font-semibold tracking-tight sm:text-3xl">Auf deinem Server</h2>
					<p class="text-muted-foreground mt-3 text-sm leading-relaxed sm:text-base">
						Oberfläche und Server stecken beide im Abbild. Ein Container, ein Volume. Gebaut für
						<code class="bg-muted rounded px-1 py-0.5 font-mono text-xs">linux/amd64</code> und
						<code class="bg-muted rounded px-1 py-0.5 font-mono text-xs">linux/arm64</code>, läuft
						also auch auf einem Raspberry Pi.
					</p>

					<ul class="mt-5 space-y-2.5 text-sm">
						{#each ["Eine SQLite-Datei unter /data. Sichern heißt: Datei kopieren.", "Registrierung ist aus, bis du Einladungscodes vergibst.", "Läuft als eigener Benutzer, nicht als root.", "Port liegt auf 127.0.0.1, dein Reverse-Proxy davor."] as p (p)}
							<li class="flex items-start gap-2.5">
								<CheckIcon class="mt-0.5 size-4 shrink-0" />
								<span class="text-muted-foreground">{p}</span>
							</li>
						{/each}
					</ul>

					<div class="mt-6 flex flex-wrap gap-2">
						<Button
							variant="outline"
							size="sm"
							href="{WIKI_URL}/Server-betreiben"
							target="_blank"
							rel="noreferrer noopener"
						>
							<ExternalLinkIcon class="size-3.5" /> Anleitung im Wiki
						</Button>
					</div>
				</div>

				<div class="bg-card overflow-hidden rounded-xl border shadow-sm">
					<div class="text-muted-foreground flex items-center gap-2 border-b px-4 py-2.5 text-xs">
						<ServerIcon class="size-3.5" />
						<span class="font-mono">docker-compose.yml</span>
						<button
							type="button"
							class="hover:text-foreground ml-auto flex items-center gap-1.5 transition-colors"
							onclick={befehlKopieren}
						>
							<CopyIcon class="size-3.5" /> pull-Befehl kopieren
						</button>
					</div>
					<!-- overflow-x-auto: die Zeilen sind laenger als ein Handydisplay,
					     und umgebrochenes YAML liest sich falsch. -->
					<pre class="overflow-x-auto p-4 font-mono text-xs leading-relaxed"><code
							>services:
  timetracker:
    image: {IMAGE_REF}
    restart: unless-stopped
    environment:
      ORIGIN: https://tracker.example.de
      RP_ID: tracker.example.de
      INVITE_CODES: dein-erster-code
    volumes:
      - timetracker-data:/data
    ports:
      - "3000:3000"

volumes:
  timetracker-data:</code
						></pre>
				</div>
			</div>
		</div>
	</section>

	<!-- ---------- Fuss ---------- -->
	<footer class="pb-[max(2rem,env(safe-area-inset-bottom))]">
		<div
			class="text-muted-foreground mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-8 text-sm sm:px-6"
		>
			<div class="flex items-center gap-2">
				<img src="/logo.svg" alt="" class="size-5" />
				<span class="text-foreground font-medium">TimeTracker</span>
				<span>· MIT-Lizenz</span>
			</div>
			<a
				class="hover:text-foreground ml-auto flex items-center gap-1.5 transition-colors"
				href={REPO_URL}
				target="_blank"
				rel="noreferrer noopener"
			>
				<GithubIcon class="size-4" /> Quelltext
			</a>
			<a
				class="hover:text-foreground flex items-center gap-1.5 transition-colors"
				href={WIKI_URL}
				target="_blank"
				rel="noreferrer noopener"
			>
				<BookOpenIcon class="size-4" /> Wiki
			</a>
			<a
				class="hover:text-foreground flex items-center gap-1.5 transition-colors"
				href={RELEASES_URL}
				target="_blank"
				rel="noreferrer noopener"
			>
				<DownloadIcon class="size-4" /> Releases
			</a>
		</div>
	</footer>
</div>
