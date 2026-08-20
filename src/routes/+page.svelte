<script lang="ts">
	import { onMount, tick } from "svelte";
	import { listen, emit } from "@tauri-apps/api/event";
	import { getCurrentWindow } from "@tauri-apps/api/window";
	import { invoke } from "@tauri-apps/api/core";
	import { enable, isEnabled } from "@tauri-apps/plugin-autostart";
	import { checkForUpdate, openUpdateDialog, updater } from "$lib/updater.svelte";
	import { getVersion } from "@tauri-apps/api/app";
	import { toast } from "svelte-sonner";
	import { app } from "$lib/app.svelte";
	import { errorText, logError, logFile, logInfo, logWarn, pruneOldLogs } from "$lib/log";
	import { appDataDir, join } from "@tauri-apps/api/path";
	import { revealItemInDir } from "@tauri-apps/plugin-opener";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import { scheduleReminders, scheduleReportReminder } from "$lib/reminders";
	import { applyShortcuts } from "$lib/shortcuts";
	import { startWatchers, stopWatchers, watchers } from "$lib/watchers.svelte";
	import { entriesFocus } from "$lib/entriesFocus.svelte";
	import * as Tabs from "$lib/components/ui/tabs";
	import TimerIcon from "@lucide/svelte/icons/timer";
	import PencilLineIcon from "@lucide/svelte/icons/pencil-line";
	import ChartColumnIcon from "@lucide/svelte/icons/chart-column";
	import LayersIcon from "@lucide/svelte/icons/layers";
	import UsersIcon from "@lucide/svelte/icons/users";
	import SettingsIcon from "@lucide/svelte/icons/settings";
	import CircleArrowUpIcon from "@lucide/svelte/icons/circle-arrow-up";
	import TrackingPanel from "$lib/components/TrackingPanel.svelte";
	import EntryEditor from "$lib/components/EntryEditor.svelte";
	import ReportView from "$lib/components/ReportView.svelte";
	import ActivitiesPanel from "$lib/components/ActivitiesPanel.svelte";
	import SettingsPanel from "$lib/components/SettingsPanel.svelte";
	import TeamPanel from "$lib/components/TeamPanel.svelte";
	import IdleDialog from "$lib/components/IdleDialog.svelte";
	import LongTimerDialog from "$lib/components/LongTimerDialog.svelte";
	import OnboardingWizard from "$lib/components/OnboardingWizard.svelte";
	import CommandPalette from "$lib/components/CommandPalette.svelte";
	import ReportReminderDialog from "$lib/components/ReportReminderDialog.svelte";
	import BackdateDialog from "$lib/components/BackdateDialog.svelte";
	import AbsenceOverrideDialog from "$lib/components/AbsenceOverrideDialog.svelte";
	import UpdateDialog from "$lib/components/UpdateDialog.svelte";

	let tab = $state("tracking");
	let paletteOpen = $state(false);

	/** Laufende Version, sobald der Start sie gelesen hat ("" bis dahin). */
	let appVersion = $state("");
	/**
	 * Vorabversion? Alles mit Semver-Vorabteil zaehlt dazu ("0.8.1-beta.2").
	 *
	 * Wer den Beta-Kanal anhat, sieht sonst nicht, ob er gerade eine Vorabversion
	 * laufen hat – die Version steht nur unten in den Einstellungen. Beim Melden
	 * eines Fehlers ist genau das die erste Frage.
	 */
	const isBeta = $derived(appVersion.includes("-"));

	// „Benachrichtigung" = einer der Aufmerksamkeits-Dialoge ist offen/fällig.
	// Wird an das Tray-Flyout gemeldet, das dann ein Hinweis-Badge zeigt.
	const attention = $derived(
		!!watchers.idlePrompt ||
			!!watchers.longTimerPrompt ||
			watchers.forceReportReminder ||
			(!!app.pendingReportMonth &&
				app.settings.reportReminderEnabled &&
				!watchers.reportReminderDismissed)
	);

	// Die einzige Stelle, die die Tabs kennt: wer einen Tag zeigen will (Tracking,
	// Arbeitszeit-Check), meldet den Wunsch an entriesFocus an, und der ruft das
	// hier auf. Bewusst ein Rueckruf und kein Effekt auf `pendingDate` – den
	// Wunsch raeumt die Eintraege-Ansicht beim Lesen ab, ein zweiter Verbraucher
	// haette das Nachsehen (siehe entriesFocus.svelte.ts).
	entriesFocus.onShow(() => (tab = "entries"));

	// Von der Tracking-Ansicht: zu den Einträgen wechseln und heute mittig zeigen.
	function showEntriesToday() {
		entriesFocus.requestToday();
	}

	/**
	 * Aus dem Tracking-Hinweis in den Arbeitszeit-Check.
	 *
	 * Nur den Tab zu wechseln reicht nicht: die Karte steht unter Verifikation und
	 * Auswertung, man landet also oben und muss suchen. Das `tick()` wartet, bis
	 * der Tab-Inhalt sichtbar ist – vorher hat das Ziel keine Position.
	 */
	async function showArbZgCheck() {
		tab = "report";
		await tick();
		document.getElementById("arbzg-check")?.scrollIntoView({ block: "start", behavior: "smooth" });
	}

	function onGlobalKey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
			e.preventDefault();
			paletteOpen = !paletteOpen;
		}
	}

	const unlisteners: Array<() => void> = [];

	// Laeuft nur, solange auf ein sichtbares Fenster gewartet wird (siehe unten).
	let visibilityPoll: ReturnType<typeof setInterval> | undefined;
	/**
	 * Das laufende Warten auf ein sichtbares Fenster – alle Wartenden teilen es.
	 *
	 * Ohne das setzte ein zweiter Aufruf `visibilityPoll` neu, und der Timer des
	 * ersten liefe fuer immer weiter. Erreichbar, seit die Update-Suche nicht mehr
	 * nur beim Start laeuft: findet sie eine neuere Version, waehrend das Fenster
	 * vom Autostart noch versteckt ist, warten zwei.
	 */
	let visibilityWait: Promise<void> | null = null;

	/**
	 * Warten, bis das Hauptfenster tatsaechlich zu sehen ist.
	 *
	 * Beim Autostart startet die App mit `--autostart-hidden`: die Oberflaeche
	 * laeuft, nur sieht sie niemand. Ein Toast dort ist laengst abgelaufen, bevor
	 * jemand das Fenster oeffnet – genau so ging der Update-Hinweis jeden Morgen
	 * verloren, und die Suche musste man in den Einstellungen wiederholen.
	 *
	 * Minimiert zaehlt nicht als sichtbar; `isVisible()` sagt dazu ja.
	 */
	function whenWindowVisible(): Promise<void> {
		const win = getCurrentWindow();
		visibilityWait ??= new Promise((resolve) => {
			const done = () => {
				clearInterval(visibilityPoll);
				visibilityPoll = undefined;
				// Vor dem Aufloesen: ein spaeterer Aufruf soll neu nachsehen, das
				// Fenster kann dann laengst wieder weg sein.
				visibilityWait = null;
				resolve();
			};
			const check = async () => {
				try {
					if ((await win.isVisible()) && !(await win.isMinimized())) done();
				} catch {
					// Kein Desktop oder Fenster weg: lieber zeigen als verschlucken.
					done();
				}
			};
			visibilityPoll = setInterval(() => void check(), 1000);
			void check();
		});
		return visibilityWait;
	}

	/**
	 * Abstand der Update-Suche im Hintergrund.
	 *
	 * Gesucht wurde vorher nur beim Start. Bei einer App, die im Autostart liegt
	 * und wochenlang im Tray durchlaeuft, war das genau einmal – ein Update kam
	 * damit erst beim naechsten Neustart des Rechners an.
	 */
	const UPDATE_CHECK_MS = 60 * 60 * 1000;
	/**
	 * Wartezeit der ersten Update-Suche, wenn die App versteckt startet.
	 *
	 * Beim Autostart faellt der Start in den Login, wo sich Windows, Virenscanner
	 * und jedes andere Startprogramm um Platte und Netz streiten. Zeigen liesse
	 * sich ein Fund dort ohnehin nicht: der Hinweis wartet auf ein sichtbares
	 * Fenster (whenWindowVisible).
	 */
	const HIDDEN_UPDATE_DELAY_MS = 2 * 60 * 1000;
	let updateTimer: ReturnType<typeof setInterval> | undefined;
	/** Version, zu der schon ein Hinweis stand – sonst meldete jede Runde dieselbe. */
	let announcedVersion: string | null = null;

	/** Still nach einem Update suchen und beim ersten Fund darauf hinweisen. */
	async function checkAndAnnounceUpdate() {
		// Nicht dazwischenfunken, solange der Dialog offen ist oder installiert
		// wird: `check()` tauscht `updater.pending` aus – mitten im Herunterladen
		// zoege das dem Dialog das Update unter den Fuessen weg.
		if (updater.open || updater.installing) return;
		if (!(await checkForUpdate({ silent: true }))) return;
		const version = updater.pending?.version;
		if (!version || version === announcedVersion) return;
		// Vor dem Warten merken: sonst stellte sich stuendlich ein weiterer Hinweis
		// zu derselben Version an, solange das Fenster versteckt ist – und beim
		// Oeffnen kaemen sie alle auf einmal.
		announcedVersion = version;
		// Erst zeigen, wenn jemand hinsieht (Autostart!) – und dann lange genug,
		// dass der Blick auch mal woanders sein darf.
		await whenWindowVisible();
		logInfo(`Hinweis auf Update ${version} gezeigt`);
		toast.info(`Update ${version} verfügbar`, {
			duration: 60000,
			action: { label: "Installieren", onClick: () => void openUpdateDialog() }
		});
	}

	/**
	 * Alles einrichten, was die App zum Laufen braucht.
	 *
	 * Laeuft beim "Erneut versuchen" im Ladebildschirm nochmal – die Ereignis-Abos
	 * deshalb nur beim ersten erfolgreichen Durchlauf, sonst reagierte die App
	 * danach doppelt auf jeden Tray-Klick.
	 */
	async function startup() {
		// Als erstes ins Protokoll, mit Version: bei "seit dem Update geht X nicht"
		// ist genau das die Zeile, an der die Suche beginnt.
		let version = "?";
		try {
			version = await getVersion();
			appVersion = version;
		} catch {
			/* nicht-desktop */
		}
		logInfo(`Hauptfenster startet (Version ${version})`);
		// Nicht abwarten: das Aufraeumen alter Tage darf den Start nicht bremsen.
		void pruneOldLogs();

		// false = Laden gescheitert; der Ladebildschirm zeigt Schritt und Meldung.
		if (!(await app.init())) return;
		try {
			if (unlisteners.length === 0) {
				unlisteners.push(
					await listen("tray-stop-timer", () => void app.stop()),
					await listen<string>("tray-start-activity", (e) => void app.startActivity(e.payload)),
					// Flyout-Fenster hat Daten geändert -> neu laden.
					await listen("data-reload", () => void app.reload()),
					// Tray-Flyout wurde geöffnet und fragt den aktuellen Hinweis-Status ab.
					await listen("tray-request-attention", () => {
						void emit("main-attention", { active: attention }).catch(() => {});
					})
				);
			}
			scheduleReminders();
			scheduleReportReminder();
			void applyShortcuts();
			startWatchers();

			// Autostart bei Login standardmaessig aktivieren (laeuft dann versteckt im Tray).
			if (app.settings.autostart) {
				try {
					if (!(await isEnabled())) await enable();
				} catch (e) {
					logWarn("Autostart konnte nicht aktiviert werden", e);
				}
			}
		} catch (e) {
			// Die Daten stehen, nur das Drumherum klemmt – das gehoert gesagt, statt
			// als abgewiesene Promise in der Konsole zu verschwinden.
			logError("Einrichtung nach dem Laden fehlgeschlagen", e);
			toast.error(`Einrichtung unvollständig: ${errorText(e)}`, { duration: 60000 });
		}

		// Beim Start und danach stuendlich still nach Updates suchen. „Installieren"
		// im Hinweis öffnet direkt den Update-Dialog – vorher landete man nur im
		// Einstellungs-Tab und musste die Suche dort von Hand wiederholen.
		//
		// `??=`: `startup()` läuft beim „Erneut versuchen" im Ladebildschirm noch
		// einmal, ein zweiter Timer suchte danach doppelt.
		updateTimer ??= setInterval(() => void checkAndAnnounceUpdate(), UPDATE_CHECK_MS);
		// Versteckt gestartet? Dann hat die Suche keine Eile (HIDDEN_UPDATE_DELAY_MS).
		const sichtbar = await getCurrentWindow()
			.isVisible()
			.catch(() => true);
		if (!sichtbar) await new Promise((r) => setTimeout(r, HIDDEN_UPDATE_DELAY_MS));
		await checkAndAnnounceUpdate();
	}

	onMount(() => {
		void startup();
		return () => {
			unlisteners.forEach((u) => u());
			unlisteners.length = 0;
			clearInterval(visibilityPoll);
			visibilityPoll = undefined;
			visibilityWait = null;
			clearInterval(updateTimer);
			updateTimer = undefined;
			stopWatchers();
			app.dispose();
		};
	});

	/** Protokollordner im Explorer zeigen – vom Fehlerbildschirm aus. */
	async function openLogFolder() {
		try {
			await revealItemInDir(await join(await appDataDir(), logFile()));
		} catch (e) {
			toast.error(`Ordner nicht zu öffnen: ${errorText(e)}`, { duration: 30000 });
		}
	}

	// Sekunden im Ladebildschirm. Ab einer Weile ist "Laedt…" keine Auskunft mehr,
	// sondern nur noch die Frage, ob ueberhaupt etwas passiert – dann nennt der
	// Bildschirm den Schritt, an dem es haengt.
	let waiting = $state(0);
	$effect(() => {
		if (app.loaded || app.initError) return;
		waiting = 0;
		const id = setInterval(() => waiting++, 1000);
		return () => clearInterval(id);
	});

	// Tray-Menü (OneDrive-Stil) aktuell halten: laufender Timer + Schnellstart (Favoriten, zuletzt benutzt).
	$effect(() => {
		if (!app.loaded) return;

		const quick = app
			.quickActivities(6)
			.map((a) => ({ id: a.id, name: a.name, favorite: !!a.favorite }));
		const running = app.running ? app.activityName(app.running.activityId) : null;
		void invoke("set_tray_state", { state: { running, activities: quick } }).catch(() => {});
	});

	// Chef-Modus abgeschaltet, während der Team-Tab offen war: sonst bliebe eine
	// leere Seite ohne zugehörigen Reiter stehen.
	$effect(() => {
		if (tab === "team" && !app.settings.bossMode) tab = "tracking";
	});

	// Hinweis-Status ans Tray-Flyout melden, sobald er sich ändert.
	$effect(() => {
		const active = attention;
		void emit("main-attention", { active }).catch(() => {});
	});
</script>

{#if !app.loaded}
	<!-- Ladebildschirm mit Auskunft: welcher Schritt laeuft, wie lange schon, und
	     bei einem Fehler die Meldung samt Weg zurueck. Vorher stand hier nur
	     "Laedt…" – nach einem Update blieb die App genau so stehen, ohne dass
	     erkennbar war, woran es haengt. -->
	<div class="flex min-h-screen items-center justify-center p-8">
		<div class="w-full max-w-md space-y-4 text-center">
			<img src="/logo.svg" alt="TimeTracker" class="mx-auto h-12 w-auto" />
			{#if app.initError}
				<div class="space-y-1">
					<h1 class="text-lg font-semibold">Start fehlgeschlagen</h1>
					<p class="text-muted-foreground text-sm">Schritt: {app.initError.step}</p>
				</div>
				<pre
					class="bg-muted max-h-40 overflow-auto rounded-md p-3 text-left text-xs whitespace-pre-wrap select-text">{app
						.initError.message}</pre>
				<p class="text-muted-foreground text-xs">
					Deine erfassten Zeiten sind davon nicht betroffen – sie liegen als Dateien im
					App-Datenordner.
				</p>
				<div class="flex flex-wrap justify-center gap-2">
					<Button onclick={() => void startup()}>Erneut versuchen</Button>
					<Button variant="outline" onclick={() => location.reload()}>Neu laden</Button>
					<!-- Hier ist die App unbedienbar; das Protokoll ist der einzige Weg,
					     mehr ueber die Ursache zu erfahren als diese eine Zeile. -->
					<Button variant="outline" onclick={openLogFolder}>Protokoll öffnen</Button>
				</div>
			{:else}
				<p class="text-muted-foreground text-sm">
					{app.initStep ? `${app.initStep}…` : "Lädt…"}
				</p>
				{#if waiting >= 8}
					<div class="space-y-2">
						<p class="text-muted-foreground text-xs">
							Das dauert ungewöhnlich lange ({waiting}&nbsp;s bei „{app.initStep ?? "Start"}").
						</p>
						<Button variant="outline" size="sm" onclick={() => location.reload()}>Neu laden</Button>
					</div>
				{/if}
			{/if}
		</div>
	</div>
{:else}
	<Tabs.Root bind:value={tab}>
		<header
			class="bg-background/80 supports-backdrop-filter:bg-background/60 sticky top-0 z-30 border-b backdrop-blur"
		>
			<div class="mx-auto grid max-w-6xl grid-cols-[1fr_auto_1fr] items-center gap-x-6 px-6 py-2.5">
				<div class="flex items-center gap-2 justify-self-start">
					<button
						type="button"
						onclick={() => (tab = "tracking")}
						class="cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
						aria-label="Startseite"
					>
						<!-- Wechselt mit, wie Tray- und Taskleisten-Icon: laufender Timer =
						     Terrakotta. Nur hier in der Kopfzeile, nicht im Ladebildschirm –
						     dort ist noch nichts geladen, was laufen koennte. -->
						<img
							src={app.running ? "/logo-running.svg" : "/logo.svg"}
							alt="TimeTracker"
							class="h-12 w-auto transition-transform hover:scale-105"
						/>
					</button>
					{#if isBeta}
						<!-- Neben dem Logo, nicht rechts bei den Statusanzeigen: das ist keine
						     Meldung, die kommt und geht, sondern gilt fuer diese Installation. -->
						<Badge variant="outline" title="Vorabversion {appVersion}">Beta</Badge>
					{/if}
				</div>

				<Tabs.List variant="line" class="justify-self-center gap-2">
					<Tabs.Trigger value="tracking"><TimerIcon />Tracking</Tabs.Trigger>
					<!-- Wie „Einträge anzeigen“ aus dem Tracking: auf heute springen. -->
					<Tabs.Trigger value="entries" onclick={() => entriesFocus.requestToday()}>
						<PencilLineIcon />Einträge
					</Tabs.Trigger>
					<Tabs.Trigger value="report"><ChartColumnIcon />Bericht</Tabs.Trigger>
					{#if app.settings.bossMode}
						<Tabs.Trigger value="team"><UsersIcon />Team</Tabs.Trigger>
					{/if}
					<Tabs.Trigger value="activities"><LayersIcon />Aktivitäten</Tabs.Trigger>
					<Tabs.Trigger value="settings"><SettingsIcon />Einstellungen</Tabs.Trigger>
				</Tabs.List>

				<!-- reservierte rechte Spalte: Pill verschiebt die Tabs nicht mehr -->
				<div class="flex items-center gap-2 justify-self-end">
					<!-- Bleibt stehen, solange das Update aussteht: der Hinweis-Toast beim
					     Start ist beim Autostart nicht zu sehen und danach weg. -->
					{#if updater.pending}
						<button
							type="button"
							onclick={() => void openUpdateDialog()}
							title="Update {updater.pending.version} verfügbar – jetzt installieren"
							aria-label="Update {updater.pending.version} verfügbar"
							class="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 relative inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2"
						>
							<CircleArrowUpIcon class="size-4.5" />
							<!-- Ruhiger Punkt, kein Pulsieren: das gehoert daneben dem laufenden
							     Timer, sonst sagen zwei Herzschlaege dasselbe. -->
							<span
								class="bg-primary ring-background absolute top-0.5 right-0.5 size-2 rounded-full ring-2"
							></span>
						</button>
					{/if}
					{#if app.running}
						<span
							class="border-primary/20 bg-primary/10 text-primary inline-flex max-w-45 items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium"
						>
							<span class="relative flex size-2 shrink-0">
								<span
									class="bg-primary absolute inline-flex size-full animate-ping rounded-full opacity-75"
								></span>
								<span class="bg-primary relative inline-flex size-2 rounded-full"></span>
							</span>
							<span class="truncate">{app.activityName(app.running.activityId)}</span>
						</span>
					{/if}
				</div>
			</div>
		</header>

		<!-- pb-12: die letzte Card soll nicht auf der Fensterkante aufsitzen. -->
		<div class="mx-auto w-full max-w-6xl px-6 pb-12">
			<Tabs.Content value="tracking" class="mt-0">
				<TrackingPanel onShowEntries={showEntriesToday} onShowReport={showArbZgCheck} />
			</Tabs.Content>
			<Tabs.Content value="entries" class="mt-4">
				<EntryEditor />
			</Tabs.Content>
			<Tabs.Content value="report" class="mt-4">
				<ReportView />
			</Tabs.Content>
			<!-- Nur bei aktivem Chef-Modus einhaengen: bits-ui baut ALLE Tab-Inhalte
			     sofort auf, ein blosses Ausblenden liesse das Panel mitlaufen. -->
			{#if app.settings.bossMode}
				<Tabs.Content value="team" class="mt-4">
					<TeamPanel />
				</Tabs.Content>
			{/if}
			<Tabs.Content value="activities" class="mt-4">
				<ActivitiesPanel />
			</Tabs.Content>
			<Tabs.Content value="settings" class="mt-4">
				<SettingsPanel />
			</Tabs.Content>
		</div>
	</Tabs.Root>

	<IdleDialog />
	<LongTimerDialog />
	<ReportReminderDialog />
	<BackdateDialog />
	<AbsenceOverrideDialog />
	<UpdateDialog />

	{#if app.showOnboarding}
		<OnboardingWizard />
	{/if}
	<CommandPalette bind:open={paletteOpen} onNavigate={(t) => (tab = t)} />
{/if}

<svelte:window onkeydown={onGlobalKey} />
