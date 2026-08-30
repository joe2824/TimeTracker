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
	import { account } from "$lib/sync/account.svelte";
	import { capabilities, isTauri } from "$lib/platform/env";
	import type { DataChanged } from "$lib/platform/windows";
	import { onPairLink } from "$lib/platform/deeplink";
	import WebOnboarding from "$lib/components/onboarding/WebOnboarding.svelte";
	import { onboardingOffen } from "$lib/onboarding.svelte";
	import PasskeyNudge from "$lib/components/onboarding/PasskeyNudge.svelte";
	import { errorText, logError, logFile, logInfo, logWarn, pruneOldLogs } from "$lib/log";
	import { appDataDir, join } from "@tauri-apps/api/path";
	import { revealInFolder } from "$lib/platform/open";
	import { Button } from "$lib/components/ui/button";
	import * as Dialog from "$lib/components/ui/dialog";
	import { Badge } from "$lib/components/ui/badge";
	import { scheduleReminders, scheduleReportReminder } from "$lib/reminders";
	import { applyShortcuts } from "$lib/shortcuts";
	import { startWatchers, stopWatchers, watchers } from "$lib/watchers.svelte";
	import { entriesFocus } from "$lib/entriesFocus.svelte";
	import * as Tabs from "$lib/components/ui/tabs";
	import SyncHint from "$lib/components/shared/SyncHint.svelte";
	import TimerIcon from "@lucide/svelte/icons/timer";
	import PencilLineIcon from "@lucide/svelte/icons/pencil-line";
	import ChartColumnIcon from "@lucide/svelte/icons/chart-column";
	import LayersIcon from "@lucide/svelte/icons/layers";
	import UsersIcon from "@lucide/svelte/icons/users";
	import SettingsIcon from "@lucide/svelte/icons/settings";
	import CircleArrowUpIcon from "@lucide/svelte/icons/circle-arrow-up";
	import LogOutIcon from "@lucide/svelte/icons/log-out";
	import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
	import TrackingPanel from "$lib/components/TrackingPanel.svelte";
	import EntryEditor from "$lib/components/EntryEditor.svelte";
	import ReportView from "$lib/components/ReportView.svelte";
	import ActivitiesPanel from "$lib/components/panels/ActivitiesPanel.svelte";
	import SettingsPanel from "$lib/components/SettingsPanel.svelte";
	import TeamPanel from "$lib/components/TeamPanel.svelte";
	import IdleDialog from "$lib/components/dialogs/IdleDialog.svelte";
	import LongTimerDialog from "$lib/components/dialogs/LongTimerDialog.svelte";
	import OnboardingWizard from "$lib/components/onboarding/OnboardingWizard.svelte";
	import CommandPalette from "$lib/components/dialogs/CommandPalette.svelte";
	import ReportReminderDialog from "$lib/components/dialogs/ReportReminderDialog.svelte";
	import BackdateDialog from "$lib/components/dialogs/BackdateDialog.svelte";
	import AbsenceOverrideDialog from "$lib/components/dialogs/AbsenceOverrideDialog.svelte";
	import UpdateDialog from "$lib/components/dialogs/UpdateDialog.svelte";
	import WhatsNewDialog from "$lib/components/dialogs/WhatsNewDialog.svelte";
	import { whatsNew } from "$lib/whatsNew.svelte";

	let tab = $state("tracking");

	/** Im Browser ohne Konto: erst anmelden. */
	// Das Onboarding bleibt auch nach dem Verknuepfen stehen, solange es noch
	// einen Schritt zu zeigen hat - sonst waere es weg, bevor jemand sagen konnte,
	// ob er seine App noch dazuholen will.
	const brauchtAnmeldung = $derived(!isTauri() && (!account.linked || onboardingOffen.wert));
	let paletteOpen = $state(false);

	/** Laufende Version, sobald der Start sie gelesen hat ("" bis dahin). */
	let appVersion = $state("");
	/** Vorabversion? Alles mit Semver-Vorabteil zaehlt dazu ("0.8.1-beta.2"). */
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

	// Jeder Tab faengt oben an. Die Tabs teilen sich den Fensterscroll: wer den
	// langen Bericht bis ans Ende gescrollt hat, landete danach in der Erfassung
	// ebenfalls unten – obwohl er dort nie gescrollt hat.
	$effect(() => {
		tab;
		window.scrollTo({ top: 0 });
	});

	// Abmelden gehoert dorthin, wo man es sucht: oben rechts, nicht in einer Karte
	// tief in den Einstellungen. Nur im Browser - auf dem Rechner ist der Zugang
	// ein Geraete-Token, das ueber "Entkoppeln" geloest wird.
	//
	// Ohne Rueckfrage: die Sitzung ist mit einem Passkey in Sekunden zurueck.
	// AUSSER es gibt keinen - dann ist die Abmeldung eine Einbahnstrasse, und
	// zurueck kaeme man nur ueber die 24 Woerter.
	let ohnePasskey = $state(false);
	let legtAn = $state(false);

	async function abmeldenKlick() {
		try {
			if ((await account.passkeys()).length === 0) {
				ohnePasskey = true;
				return;
			}
		} catch {
			// Server nicht erreichbar: dann laesst sich nicht sagen, ob ein Passkey
			// da ist. Lieber einmal zu viel fragen als jemanden aussperren.
			ohnePasskey = true;
			return;
		}
		await abmelden();
	}

	async function abmelden() {
		ohnePasskey = false;
		try {
			await account.logout();
			toast.success("Abgemeldet.");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Abmelden fehlgeschlagen");
		}
	}

	/** Direkt aus dem Hinweis heraus einen anlegen - der Weg ist ja der Punkt. */
	async function passkeyAnlegen() {
		legtAn = true;
		try {
			await account.addPasskey("Dieser Browser");
			ohnePasskey = false;
			toast.success("Passkey angelegt. Damit kommst du jederzeit wieder hinein.");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Passkey konnte nicht angelegt werden");
		} finally {
			legtAn = false;
		}
	}

	// Von der Tracking-Ansicht: zu den Einträgen wechseln und heute mittig zeigen.
	function showEntriesToday() {
		entriesFocus.requestToday();
	}

	/** Aus dem Tracking-Hinweis in den Arbeitszeit-Check. */
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
	/** Das laufende Warten auf ein sichtbares Fenster – alle Wartenden teilen es. */
	let visibilityWait: Promise<void> | null = null;

	/** Warten, bis das Hauptfenster tatsaechlich zu sehen ist. */
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

	/** Abstand der Update-Suche im Hintergrund. */
	const UPDATE_CHECK_MS = 60 * 60 * 1000;
	/** Wartezeit der ersten Update-Suche, wenn die App versteckt startet. */
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

	/** Alles einrichten, was die App zum Laufen braucht. */
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
			// Erst NACH dem Laden: der Abgleich schreibt in denselben Bestand, und
			// ein nicht erreichbarer Server darf den Start nicht aufhalten.
			await account.init();
			whatsNew.checkOnStartup(app.showOnboarding);
			scheduleReminders();
			scheduleReportReminder();

			// Alles Weitere gibt es nur in der Desktop-Huelle: Tray-Ereignisse,
			// globale Hotkeys, Leerlauf-Erkennung, Autostart und die Update-Suche.
			// Im Browser wuerde jeder dieser Aufrufe werfen - und zwar mitten in der
			// Einrichtung, sodass danach auch nichts Harmloses mehr liefe.
			if (!isTauri()) return;

			if (unlisteners.length === 0) {
				unlisteners.push(
					await listen("tray-stop-timer", () => void app.stop()),
					await listen<string>("tray-start-activity", (e) => void app.startActivity(e.payload)),
					// Flyout-Fenster hat Daten geändert -> neu laden.
					// Ein Klick auf "In der App öffnen" im Browser landet hier.
					await onPairLink((code) => {
						account.pairCodeFromLink = code;
						tab = "settings";
						toast.info("Kopplungscode übernommen – bitte bestätigen.");
					}),
					await listen<DataChanged>("data-reload", (e) => {
						// Der eigene Ruf ginge sonst im Kreis: syncNow meldet nach jedem
						// Zulauf, und die Nachlese unten stiesse den naechsten an.
						if (e.payload?.from === "main") return;
						void app.reload();
						// Das Tray schreibt ohne Haken - erst hier wird daraus etwas,
						// das den Server erreicht.
						void account.nachlese();
					}),
					// Tray-Flyout wurde geöffnet und fragt den aktuellen Hinweis-Status ab.
					await listen("tray-request-attention", () => {
						void emit("main-attention", { active: attention }).catch(() => {});
					})
				);
			}
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
		// im Hinweis öffnet direkt den Update-Dialog.
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
			account.dispose();
			app.dispose();
		};
	});

	/** Protokollordner im Explorer zeigen – vom Fehlerbildschirm aus. */
	async function openLogFolder() {
		try {
			await revealInFolder(await join(await appDataDir(), logFile()));
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

{#if !app.loaded || (!isTauri() && !account.ready)}
	<!-- Ladebildschirm mit Auskunft: welcher Schritt laeuft, wie lange schon, und
	     bei einem Fehler die Meldung samt Weg zurueck. -->
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
				<!-- Im Browser bleibt es still: dort dauert der Start Millisekunden, und
				     "Einstellungen suchen…" waere ein Aufblitzen, das nur Unruhe stiftet.
				     Auf dem Rechner ist es die Auskunft, an der man erkennt, woran es
				     haengt - dort steht sie sofort. Zieht es sich hier doch, sagt der
				     Block darunter Bescheid. -->
				{#if isTauri()}
					<p class="text-muted-foreground text-sm">
						{app.initStep ? `${app.initStep}…` : "Lädt…"}
					</p>
				{/if}
				{#if waiting >= (isTauri() ? 8 : 3)}
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
{:else if brauchtAnmeldung}
	<!--
		Im Browser gibt es ohne Konto nichts zu zeigen - anders als auf dem
		Rechner, wo die Daten ohnehin lokal liegen. Deshalb steht die Anmeldung
		hier VOR der Oberflaeche und nicht in den Einstellungen.
	-->
	<WebOnboarding />
{:else}
	<Tabs.Root bind:value={tab}>
		<!-- pt-safe: die Kopfzeile klebt oben, also traegt sie den Abstand zur
		     Statusleiste/Notch. Ohne das liegt das Logo auf dem Handy darunter. -->
		<header
			class="bg-background/80 supports-backdrop-filter:bg-background/60 sticky top-0 z-30 border-b pt-[env(safe-area-inset-top)] backdrop-blur"
		>
			<!-- Ab sm: drei Spalten nebeneinander (Logo | Tabs | Status).
			     Auf sehr schmalen Displays (xs) bleiben zwei Reihen als Fallback. -->
			<div
				class="mx-auto grid max-w-6xl grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 px-4 py-2 sm:grid-cols-[1fr_auto_1fr] sm:px-6 sm:py-2.5"
			>
				<div class="col-start-1 row-start-1 flex items-center gap-2 justify-self-start">
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
							class="h-9 w-auto transition-transform hover:scale-105 sm:h-10"
						/>
					</button>
					{#if isBeta}
						<!-- Neben dem Logo, nicht rechts bei den Statusanzeigen: das ist keine
						     Meldung, die kommt und geht, sondern gilt fuer diese Installation. -->
						<Badge variant="outline" title="Vorabversion {appVersion}">Beta</Badge>
					{/if}
				</div>

				<!-- Ab sm: Tabs zentriert in Spalte 2, Reihe 1 – nicht mehr in einer
				     eigenen zweiten Reihe. Scrollbar falls die Tabs nicht alle passen. -->
				<Tabs.List
					variant="line"
					class="scrollbar-lose col-span-2 col-start-1 row-start-2 w-full justify-evenly gap-0 overflow-x-auto group-data-horizontal/tabs:h-12 sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:w-auto sm:justify-self-center sm:justify-start sm:gap-2 sm:group-data-horizontal/tabs:h-8"
				>
					<Tabs.Trigger value="tracking" title="Tracking">
						<TimerIcon /><span class="hidden sm:inline">Tracking</span>
					</Tabs.Trigger>
					<!-- Wie „Einträge anzeigen“ aus dem Tracking: auf heute springen. -->
					<Tabs.Trigger
						value="entries"
						title="Einträge"
						onclick={() => entriesFocus.requestToday()}
					>
						<PencilLineIcon /><span class="hidden sm:inline">Einträge</span>
					</Tabs.Trigger>
					<Tabs.Trigger value="report" title="Bericht">
						<ChartColumnIcon /><span class="hidden sm:inline">Bericht</span>
					</Tabs.Trigger>
					{#if app.settings.bossMode && capabilities.outlook}
						<Tabs.Trigger value="team" title="Team">
							<UsersIcon /><span class="hidden sm:inline">Team</span>
						</Tabs.Trigger>
					{/if}
					<Tabs.Trigger value="activities" title="Aktivitäten">
						<LayersIcon /><span class="hidden sm:inline">Aktivitäten</span>
					</Tabs.Trigger>
					<Tabs.Trigger value="settings" title="Einstellungen">
						<SettingsIcon /><span class="hidden sm:inline">Einstellungen</span>
					</Tabs.Trigger>
				</Tabs.List>

				<!-- reservierte rechte Spalte: Pill verschiebt die Tabs nicht mehr -->
				<div
					class="col-start-2 row-start-1 flex items-center gap-2 justify-self-end lg:col-start-3"
				>
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
					<!-- Nach dem laufenden Timer: der Abgleich ist meist nur ein Punkt und
					     stoert am Rand niemanden. -->
					<SyncHint />
					{#if account.linked && !capabilities.tray}
						<button
							type="button"
							onclick={abmeldenKlick}
							title="Abmelden"
							aria-label="Abmelden"
							class="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2"
						>
							<LogOutIcon class="size-4.5" />
						</button>
					{/if}
				</div>
			</div>
		</header>

		{#if account.phase === "laeuft" && account.syncProgress && (account.syncProgress.pulled > 0 || account.syncProgress.pushed > 0)}
			<div class="bg-primary/10 border-b border-primary/20 text-primary px-4 py-1.5 text-xs text-center font-medium flex items-center justify-center gap-2">
				<RefreshCwIcon class="size-3.5 animate-spin shrink-0" />
				{#if account.syncProgress.pulled > 0}
					<span>Daten werden vom Server geladen ({account.syncProgress.pulled} Einträge)…</span>
				{:else}
					<span>Daten werden an den Server übertragen ({account.syncProgress.pushed} Einträge)…</span>
				{/if}
			</div>
		{/if}

		<PasskeyNudge />

		<!-- pb-12: die letzte Card soll nicht auf der Fensterkante aufsitzen; auf dem
		     Handy kommt der Streifen der Gestensteuerung obendrauf. -->
		<div
			class="mx-auto w-full max-w-6xl px-4 pb-[calc(3rem+env(safe-area-inset-bottom))] sm:px-6"
		>
			<Tabs.Content value="tracking" class="mt-0">
				<TrackingPanel onShowEntries={showEntriesToday} onShowReport={showArbZgCheck} />
			</Tabs.Content>
			<Tabs.Content value="entries" class="mt-4">
				<EntryEditor />
			</Tabs.Content>
			<Tabs.Content value="report" class="mt-4">
				<ReportView />
			</Tabs.Content>
			<!-- Nur bei aktivem Chef-Modus einhaengen: bits-ui baut sonst alle
			     Tab-Inhalte mit auf, und im Browser gibt es kein Outlook dafuer. -->
			{#if app.settings.bossMode && capabilities.outlook}
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

<WhatsNewDialog />

<svelte:window
	onkeydown={onGlobalKey}
	onfocus={() => account.onVisible()}
/>

<!--
	Der wichtigste Zeitpunkt fuer einen Abgleich: das Fenster kommt zurueck. Wer
	den Rechner aufklappt, will den Stand von unterwegs sehen - nicht erst nach
	dem naechsten Takt.
-->
<svelte:document onvisibilitychange={() => !document.hidden && account.onVisible()} />

<Dialog.Root open={ohnePasskey} onOpenChange={(o) => (ohnePasskey = o)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Achtung: kein Passkey an diesem Konto</Dialog.Title>
			<Dialog.Description>
				Meldest du dich jetzt ab, kommst du nur noch über die 24 Wörter der
				Wiederherstellungs-Phrase zurück – oder indem du dieses Gerät neu koppelst.
				Ein Passkey ist in zehn Sekunden angelegt.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="ghost" disabled={legtAn} onclick={abmelden}>Trotzdem abmelden</Button>
			<Button disabled={legtAn} onclick={passkeyAnlegen}>
				{legtAn ? "Warte auf Bestätigung…" : "Passkey anlegen"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
