<script lang="ts">
	// Die minimalistische, aufgeräumte Landing Page
	import type { Snippet } from "svelte";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import GithubIcon from "$lib/components/icons/GithubIcon.svelte";
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
	import LockIcon from "@lucide/svelte/icons/lock";
	import DownloadIcon from "@lucide/svelte/icons/download";
	import CheckIcon from "@lucide/svelte/icons/check";
	import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
	import ServerIcon from "@lucide/svelte/icons/server";
	import BookOpenIcon from "@lucide/svelte/icons/book-open";

	let { auth, os }: { auth: Snippet; os: Betriebssystem } = $props();

	const desktop = $derived(hatDesktopApp(os));

	const highlights = [
		{
			icon: TimerIcon,
			title: "Schnelle Zeiterfassung",
			description: "Klick auf eine Aktivität startet den Timer. Unterstützt Pausen, Tastenkürzel und das Tray-Symbol."
		},
		{
			icon: MailIcon,
			title: "Monatsberichte & Export",
			description: "Am Monatsende sind alle Stunden fertig zusammengestellt — per Klick exportieren oder als Mail abschicken."
		},
		{
			icon: RefreshCwIcon,
			title: "Auf allen Geräten",
			description: "Egal ob am PC, Laptop oder Smartphone: Deine Arbeitszeiten sind automatisch überall auf dem neuesten Stand."
		},
		{
			icon: LockIcon,
			title: "Vollständig privat",
			description: "Deine Daten werden direkt auf deinem Gerät verschlüsselt. Niemand außer dir kann deine erfassten Zeiten einsehen."
		}
	];
</script>

<div class="min-h-dvh flex flex-col bg-background text-foreground selection:bg-primary/20">
	<!-- ---------- Kopfzeile ---------- -->
	<header class="bg-background/80 supports-backdrop-filter:bg-background/60 sticky top-0 z-40 border-b pt-[env(safe-area-inset-top)] backdrop-blur">
		<div class="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
			<a href="#oben" class="flex items-center gap-2.5 font-semibold tracking-tight hover:opacity-90 transition-opacity">
				<img src="/logo.svg" alt="" class="size-7" />
				<span>TimeTracker</span>
			</a>

			<div class="flex items-center gap-2">
				{#if desktop}
					<Button
						variant="outline"
						size="sm"
						href={RELEASES_URL}
						target="_blank"
						rel="noreferrer noopener"
						class="hidden sm:inline-flex gap-1.5 font-medium shadow-2xs"
					>
						<DownloadIcon class="size-3.5 text-primary" />
						<span>Windows-App</span>
					</Button>
				{/if}
				<Button
					variant="ghost"
					size="icon"
					href={REPO_URL}
					target="_blank"
					rel="noreferrer noopener"
					aria-label="GitHub Repository"
					class="size-8 text-muted-foreground hover:text-foreground"
				>
					<GithubIcon class="size-4" />
				</Button>
			</div>
		</div>
	</header>

	<!-- ---------- Hero & Anmelde-Bereich ---------- -->
	<main class="flex-1">
		<section id="oben" class="py-8 sm:py-16 border-b">
			<div class="relative mx-auto max-w-5xl px-4 sm:px-6">
				<!-- Kompakter Hero-Titel auf Mobile direkt über der Karte -->
				<div class="mb-5 text-center lg:hidden">
					<h1 class="text-2xl font-semibold tracking-tight text-foreground">Projektzeiten erfassen</h1>
					<p class="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">Einfach, passwortlos per Passkey und auf allen Geräten synchronisiert.</p>
				</div>

				<div class="grid gap-8 lg:grid-cols-[1.1fr_minmax(0,24rem)] lg:items-center lg:gap-12">
					<!-- Textspalte (Auf Desktop links, auf Mobile/Tablet zentriert unter der Karte) -->
					<div class="order-2 flex flex-col items-center text-center gap-4 lg:order-1 lg:items-start lg:text-left">
						<Badge variant="outline" class="hidden lg:inline-flex h-6 gap-1.5 px-2.5 text-xs font-medium border-primary/20 bg-primary/5 text-primary">
							<LockIcon class="size-3" />
							Ende-zu-Ende verschlüsselt
						</Badge>

						<h1 class="hidden lg:block text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl leading-tight">
							Projektzeiten erfassen.<br />
							<span class="text-muted-foreground font-medium">Einfach & sicher.</span>
						</h1>

						<p class="hidden sm:block text-muted-foreground text-sm sm:text-base leading-relaxed max-w-lg mx-auto lg:mx-0">
							TimeTracker läuft im Tray oder direkt im Browser. Melde dich passwortlos per Passkey an — deine Daten gehören nur dir.
						</p>

						<ul class="inline-grid gap-2.5 text-xs sm:text-sm text-muted-foreground pt-1 sm:grid-cols-2 text-left mx-auto lg:mx-0">
							<li class="flex items-center gap-2">
								<CheckIcon class="size-4 shrink-0 text-primary" />
								<span>Passkeys (Face ID, Touch ID, PIN)</span>
							</li>
							<li class="flex items-center gap-2">
								<CheckIcon class="size-4 shrink-0 text-primary" />
								<span>Multi-Geräte-Synchronisation</span>
							</li>
							<li class="flex items-center gap-2">
								<CheckIcon class="size-4 shrink-0 text-primary" />
								<span>Kein Passwort oder E-Mail nötig</span>
							</li>
							<li class="flex items-center gap-2">
								<CheckIcon class="size-4 shrink-0 text-primary" />
								<span>Offline-fähig & Open Source</span>
							</li>
						</ul>

						{#if desktop}
							<div class="hidden sm:flex items-center justify-center lg:justify-start gap-3 pt-2 w-full">
								<Button
									variant="outline"
									size="sm"
									class="gap-2 h-9"
									href={RELEASES_URL}
									target="_blank"
									rel="noreferrer noopener"
								>
									<DownloadIcon class="size-3.5" /> Windows-App herunterladen
								</Button>
							</div>
						{/if}
					</div>

					<!-- Anmeldekarte (Auf Mobile sofort ganz oben im Blick, auf Desktop rechts) -->
					<div id="anmelden" class="order-1 w-full max-w-md mx-auto lg:order-2 lg:max-w-none">
						{@render auth()}
					</div>
				</div>
			</div>
		</section>

		<!-- ---------- Highlights (4er Grid) ---------- -->
		<section class="py-12 sm:py-16 border-b bg-muted/20">
			<div class="mx-auto max-w-5xl px-4 sm:px-6">
				<div class="grid gap-4 sm:grid-cols-2 lg:gap-6">
					{#each highlights as item (item.title)}
						{@const Icon = item.icon}
						<div class="flex items-start gap-4 rounded-xl border bg-card p-5 shadow-2xs">
							<div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
								<Icon class="size-4.5" />
							</div>
							<div class="space-y-1">
								<h3 class="font-medium text-sm text-foreground">{item.title}</h3>
								<p class="text-xs text-muted-foreground leading-relaxed">{item.description}</p>
							</div>
						</div>
					{/each}
				</div>
			</div>
		</section>

		<!-- ---------- Selbst hosten Hinweis ---------- -->
		<section class="py-8 sm:py-10 border-b">
			<div class="mx-auto max-w-5xl px-4 sm:px-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
				<div class="flex items-center gap-3">
					<div class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
						<ServerIcon class="size-4" />
					</div>
					<div>
						<p class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Eigener Server</p>
						<p class="text-sm font-medium text-foreground">Als einzelner Docker-Container selbst hosten</p>
					</div>
				</div>
				<Button
					variant="outline"
					size="sm"
					class="gap-1.5 text-xs self-stretch sm:self-auto"
					href="{WIKI_URL}/Server-Installation"
					target="_blank"
					rel="noreferrer noopener"
				>
					<BookOpenIcon class="size-3.5" /> Anleitung im Wiki
				</Button>
			</div>
		</section>
	</main>

	<!-- ---------- Minimaler Footer ---------- -->
	<footer class="py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-xs text-muted-foreground">
		<div class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-4 sm:px-6">
			<div class="flex items-center gap-2">
				<img src="/logo.svg" alt="" class="size-4 opacity-75" />
				<span class="font-medium text-foreground">TimeTracker</span>
				<span>· MIT-Lizenz</span>
			</div>
			<div class="flex items-center gap-4">
				<a class="hover:text-foreground transition-colors" href={REPO_URL} target="_blank" rel="noreferrer noopener">GitHub</a>
				<a class="hover:text-foreground transition-colors" href={WIKI_URL} target="_blank" rel="noreferrer noopener">Wiki</a>
				<a class="hover:text-foreground transition-colors" href={RELEASES_URL} target="_blank" rel="noreferrer noopener">Releases</a>
			</div>
		</div>
	</footer>
</div>
