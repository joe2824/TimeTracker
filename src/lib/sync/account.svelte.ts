// Das Konto, wie die Oberflaeche es sieht.
import { app } from "../app.svelte";
import { logError, logInfo, logWarn } from "../log";
import {
	clearAccountData,
	clearOutbox,
	deleteTimeReport,
	loadDevice,
	loadEntries,
	loadTimeReport,
	saveDevice,
	saveEntries,
	saveTimeReport
} from "../store";
import { loadActivities, saveActivities, loadSettings, saveSettings, listEntryMonths } from "../store";
import { deviceId } from "./device";
import {
	startTracking,
	stopTracking,
	pendingChanges,
	setChangeListener,
	rememberUnstamped
} from "./outbox";
import { Api, ApiError, type AccountInfo, type BackupInfo, type DeleteSummary, type Invite, type Passkey, type ServerStats } from "./api";

import { detachLocalData } from "./detach";
import { monthKey, prevMonthKey, shiftMonthKey } from "../time";
import { SyncEngine, type SyncState } from "./engine";
import {
	createPairingKeyPair,
	createVaultKey,
	exportPairingPublicKey,
	checkedPairingKey,
	exportVaultKey,
	fromBase64,
	importVaultKey,
	normalizePairingCode,
	pairingCode,
	bucketFor,
	createClaimSecret,
	toBase64,
	unwrapForDevice,
	vaultProof,
	type KeyWrap
} from "../crypto/vault";
import { toast } from "svelte-sonner";
import { protectSecret, unprotectSecret } from "../platform/secrets";
import { isTauri } from "../platform/env";
import { platformFetch } from "../platform/http";
import { notifyDataChanged } from "../platform/windows";
import { APP_VERSION } from "../defaults";
import { classifyPingFailure, detectPlatform, type PingResult } from "../analytics";

export type LinkState = "off" | "connecting" | "connected" | "error";

/** Wie weit das Entkoppeln gehen soll - siehe `AccountState.unlink`. */
export interface UnlinkOptions {
	/** Den Zugang dieses Geraets auch beim Server beenden. */
	revokeSelf?: boolean;
	/** Das ganze Konto aufloesen, samt aller Serverdaten. */
	deleteRemote?: boolean;
}

/** Wie es dem Abgleich gerade geht - genau das, was die Oberflaeche zeigt. */
export type SyncPhase = "idle" | "running" | "offline" | "error";

/**
 * Wie lange nach einer Aenderung gewartet wird, bevor hochgeladen wird.
 *
 * Kurz genug, dass ein Timer-Start sofort drueben ist; lang genug, dass Tippen
 * in einer Notiz nicht jede Taste einzeln hochlaedt.
 */
const DEBOUNCE_MS = 400;

/** Abstand zwischen zwei Verbindungsversuchen, wachsend (maximal 30s). */
const RETRY_MS = [1_000, 3_000, 5_000, 10_000, 20_000, 30_000];

/**
 * Wie weit `remoteMonths` zurueckschaut.
 *
 * Fuenf Jahre. Die Kennungen sind HMACs, die dieses Geraet selbst rechnet -
 * sechzig Stueck kosten nichts.
 */
const REMOTE_MONTH_LOOKBACK = 60;

/**
 * Wie weit `remoteMonths` vorausschaut.
 *
 * Urlaub wird im Voraus gebucht, oft bis ins naechste Jahr. Ohne den Blick nach
 * vorn fehlten genau diese Monate in der Auswahl, solange die Historie laeuft.
 */
const REMOTE_MONTH_LOOKAHEAD = 12;

/** Der langsame Takt, wo es keinen Weckruf-Kanal gibt. */
const HEARTBEAT_MS = 5 * 60 * 1000;

/** Pause zwischen zwei Portionen Historie. */
const BACKFILL_GAP_MS = 2000;

/** Wie oft waehrend des Backfills hoechstens neu gelesen wird. */
const BACKFILL_RELOAD_MS = 5_000;

/**
 * Hochzaehlen, sobald eine neue Datensatzart hinzukommt.
 *
 * 1 = die eingelesenen Reports (timereport).
 *
 * Der Stand `seq` laeuft ueber ALLES, was der Server hat - auch ueber Arten, die
 * die damals laufende Fassung nicht kannte und deshalb stillschweigend
 * uebergangen hat. Die sind fuer dieses Geraet fuer immer weg, denn der naechste
 * Abruf beginnt hinter ihnen. Ein Wechsel dieser Zahl laesst jedes Geraet
 * einmalig von vorne holen; das Zusammenfuehren aendert dabei nichts an dem, was
 * schon stimmt.
 */
export const RESYNC_GENERATION = 1;

class AccountState {
	state = $state<LinkState>("off");
	phase = $state<SyncPhase>("idle");
	/** Anzeigename des Kontos, sobald bekannt. */
	name = $state<string>("");
	serverUrl = $state<string>("");
	/** Letzte Meldung, die einen Menschen etwas angeht. */
	message = $state<string>("");
	lastSync = $state<number | null>(null);
	/** Ob Schluessel und Token vom Betriebssystem geschuetzt sind. */
	secretsProtected = $state<boolean>(false);
	/** Wie viele eigene Aenderungen beim Zusammenfuehren unterlegen sind. */
	lostEdits = $state<number>(0);
	/** Darf dieses Konto Einladungen vergeben? */
	isAdmin = $state<boolean>(false);
	/** Weist sich dieses Geraet mit einem eigenen Token aus - oder mit einem Cookie? */
	hasDeviceToken = $state<boolean>(false);
	/**
	 * Ein Kopplungscode, der ueber einen "timetracker://"-Link hereinkam.
	 *
	 * Liegt hier und nicht in der Karte: der Link trifft das Fenster, die Karte
	 * ist zu dem Zeitpunkt vielleicht gar nicht aufgebaut. Wer ihn abholt, raeumt
	 * ihn weg.
	 */
	/**
	 * Ein Kopplungscode, der ueber einen "timetracker://"-Link hereinkam.
	 */
	pairCodeFromLink = $state<string>("");
	/** Fortschritt des aktuellen Synchronisationsvorgangs (z.B. wie viele Datensätze geladen wurden). */
	syncProgress = $state<{
		phase: "idle" | "pulling" | "pushing";
		pulled: number;
		pushed: number;
		/** Historie im Hintergrund - siehe SyncProgress. */
		background?: boolean;
	} | null>(null);

	/**
	 * Ob noch aeltere Monate nachkommen.
	 *
	 * Gespiegelt statt durchgereicht: der Zustand im Abgleich ist kein `$state`,
	 * die Oberflaeche bekaeme eine Aenderung daran sonst nie mit.
	 */
	backfilling = $state(false);
	/**
	 * Ob lokal wirklich Monate FEHLEN - daran haengen die Sperren fuer Sicherung
	 * und Einspielen.
	 *
	 * Ein Geraet, das nach einem Nachlauf nur alles noch einmal holt, hat den
	 * Bestand laengst: dort waere eine Sicherung vollstaendig, und sie zu sperren
	 * waere ein Fehlalarm.
	 */
	historyIncomplete = $state(false);
	/**
	 * Ob dieses Geraet seit dem Start einmal abgeglichen hat - erfolgreich oder
	 * gescheitert.
	 *
	 * Bis dahin ist unklar, ob das Konto schon Daten hat. Der
	 * Willkommensbildschirm wartet darauf: ein frisch gekoppeltes Geraet ist
	 * lokal leer und saehe sonst "Willkommen", waehrend die Eintraege gerade
	 * hereinkommen.
	 */
	firstSyncDone = $state(false);
	/** Monate, die gerade vom Server nachgeholt werden - die Auswahl zeigt es an. */
	fetchingMonths = $state<string[]>([]);
	/**
	 * Massen-Abruf, allein fuer die Desktop-Meldung (Toast).
	 *
	 * Im Browser haengt die Anzeige an `syncProgress`, nicht hieran.
	 */
	bulkSync = $state<{ phase: "pulling" | "done"; pulled: number } | null>(null);
	/** Ob die Initialisierung des Kontos (Lesen lokaler Zugangsdaten) abgeschlossen ist. */
	ready = $state<boolean>(false);

	#api: Api | null = null;
	#engine: SyncEngine | null = null;
	#key: CryptoKey | null = null;
	#stream: EventSource | null = null;
	#debounce: ReturnType<typeof setTimeout> | null = null;
	/** Eigener Takt fuer die Historie - der geteilte Entpreller gehoert dem Nutzer. */
	#backfillTimer: ReturnType<typeof setTimeout> | null = null;
	#retry: ReturnType<typeof setTimeout> | null = null;
	#retryStep = 0;
	#device = "";
	#heartbeat: ReturnType<typeof setInterval> | null = null;
	#listenersInstalled = false;
	/** Laeuft eine Weckruf-Schleife? Der Abbruch beendet auch die offene Anfrage. */
	#wait: AbortController | null = null;
	/** Wurde der Stand gerade zurueckgesetzt? Siehe #rewindForNewKinds. */
	#rewound = false;
	/**
	 * Wird beim Abmelden aufgerufen - von aussen registriert, um einen Kreis-Import
	 * zu vermeiden (prefetch importiert account, account darf prefetch nicht importieren).
	 */
	#logoutHook: (() => void) | null = null;

	/** Einen Haken fuer das Abmelden setzen. Derzeit: prefetch-Puffer leeren. */
	setLogoutHook(fn: () => void): void {
		this.#logoutHook = fn;
	}

	get linked(): boolean {
		return this.state === "connected";
	}

	get pending(): number {
		return this.linked ? pendingChanges().length : 0;
	}

	// ---------- Start ----------

	/** Beim Programmstart: falls ein Konto verknuepft ist, alles hochfahren. */
	async init(): Promise<void> {
		try {
			const info = await loadDevice();
			// Ohne Adresse oder Schluessel gibt es nichts zu verbinden. Das Token darf
			// fehlen: im Browser weist das Sitzungs-Cookie aus.
			if (!info?.serverUrl || !info.vaultKey) {
				if (!isTauri()) {
					// Im Browser ohne verknüpftes Konto: keine Altlasten im Speicher belassen
					await clearAccountData();
					app.clearLocalData();
				}
				return;
			}

			this.serverUrl = info.serverUrl;
			this.name = info.accountName ?? "";
			this.secretsProtected = info.protected ?? false;
			this.state = "connecting";
			try {
				const token = info.token
					? await unprotectSecret(info.token, info.protected ?? false)
					: null;
				const rawKey = await unprotectSecret(info.vaultKey, info.protected ?? false);
				this.#key = await importVaultKey(fromBase64(rawKey).buffer as ArrayBuffer);
				this.#device = await deviceId();
				this.hasDeviceToken = token !== null;
				await this.#startEngine(info.serverUrl, token, {
					seq: info.seq ?? 0,
					priority: info.priority
				});

				// Im Browser ohne festes Geraetetoken: vor der Freigabe der App prüfen,
				// ob die Sitzung (Cookie) beim Server noch gueltig ist.
				if (!isTauri() && !this.hasDeviceToken) {
					try {
						await this.accountInfo();
						this.state = "connected";
					} catch (e) {
						if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
							// Sitzung abgelaufen: Daten aufräumen und sauber in den Anmeldezustand wechseln
							logWarn("Sitzung ist abgelaufen - melde lokal ab", e);
							await this.#forgetLocally();
							await clearAccountData();
							app.clearLocalData();
							this.state = "off";
							return;
						}
						// Bei Verbindungsabbruch / Offline: offline verbunden bleiben
						this.state = "connected";
						this.phase = "offline";
					}
				} else {
					this.state = "connected";
					void this.accountInfo().catch(() => {});
				}

				logInfo("Konto verknüpft", { server: info.serverUrl });
				void this.syncWithFollowUp();
			} catch (e) {
				// Der haeufigste Grund: die Datei stammt von einem anderen
				// Benutzerkonto. Dann ist die Verknuepfung hier nichts mehr wert.
				this.state = "error";
				this.message = e instanceof Error ? e.message : "Verknüpfung nicht lesbar";
				logError("Verknüpfung konnte nicht geöffnet werden", e);
			}
		} finally {
			this.ready = true;
		}
	}

	async #startEngine(url: string, token: string | null, state: SyncState): Promise<void> {
		state = await this.#rewindForNewKinds(state);
		this.#api = new Api({ baseUrl: url, token, fetchFn: platformFetch });
		const engine = new SyncEngine({
			api: this.#api,
			key: this.#key!,
			deviceId: this.#device,
			state,
			saveState: async (s) => {
				const info = await loadDevice();
				// Erst hier pruefen, nicht vor dem Lesen: zwischen beidem kann das
				// Abmelden liegen. Eine Runde von vorher schriebe sonst den ganzen
				// gelesenen Stand zurueck - Tresorschluessel eingeschlossen - oder
				// ihren Stand in die device.json des naechsten Kontos.
				if (!info || this.#engine !== engine) return;
				await saveDevice({ ...info, seq: s.seq, priority: s.priority });
			},
			store: {
				entriesOfMonth: loadEntries,
				saveEntries,
				activities: loadActivities,
				saveActivities,
				settings: loadSettings,
				saveSettings,
				timeReport: loadTimeReport,
				saveTimeReport,
				deleteTimeReport
			},
			onProgress: (p) => {
				this.syncProgress = p.phase === "idle" ? null : p;
				if (p.phase !== "pulling") return;
				// Die Historie laeuft im Hintergrund - dafuer steht das Hinweisband
				// oben. Ein Modal davor sperrt die App zu, waehrend daneben steht,
				// man koenne schon arbeiten.
				if (p.background) {
					// Ab hier kommt nur noch Historie: der vorgezogene Teil steht, das
					// Modal darf weg - auch wenn der Durchgang noch weiterlaeuft.
					if (this.bulkSync?.phase === "pulling") this.#finishBulkSync();
					return;
				}
				if (p.pulled >= 20) {
					this.bulkSync = { phase: "pulling", pulled: p.pulled };
					if (isTauri()) {
						toast.loading(`Lade Daten (${p.pulled} Einträge)…`, { id: "sync-bulk" });
					}
				}
			}
		});
		this.#engine = engine;
		this.backfilling = state.priority !== undefined;
		this.historyIncomplete = state.priority !== undefined && state.priority.historyLocal !== true;
		this.#engine.setMonthLister(listEntryMonths);
		// Wer einen Monat oeffnet, den der Backfill noch nicht hat, soll ihn sehen -
		// nicht eine leere Ansicht mit dem Hinweis, spaeter wiederzukommen.
		app.setMonthFetcher((month) => this.ensureMonthSynced(month));
		await startTracking(this.#device);
		// Ab hier steht der Schreib-Haken. Erst jetzt darf die Reparatur der
		// eingebauten Zeilen laufen: sie haengt Eintraege um, die bereits ein `rev`
		// tragen - ohne Haken wuerde rememberUnstamped() sie nicht aufsammeln und
		// die Umhaengung erreichte den Server nie.
		await app.mergeDuplicateBuiltins();
		// Jede lokale Aenderung stoesst einen Abgleich an - gesammelt, nicht sofort.
		setChangeListener(() => this.syncSoon());
		this.#installNetworkListeners();
		this.#openStream();
	}

	/**
	 * Einmalig von vorne holen, wenn seit dem letzten Start eine Datensatzart
	 * dazugekommen ist. Siehe RESYNC_GENERATION.
	 *
	 * Der Merker wird VOR dem Abrufen gespeichert, zusammen mit dem
	 * zurueckgesetzten Stand: bricht der Abruf ab, steht der Stand weiterhin auf 0
	 * und der naechste Versuch holt den Rest - ohne den Nachlauf ein zweites Mal
	 * auszuloesen.
	 */
	async #rewindForNewKinds(state: SyncState): Promise<SyncState> {
		const info = await loadDevice();
		if (!info || info.resyncGeneration === RESYNC_GENERATION) return state;
		// Der vorgezogene Teil bleibt - sonst liefe der Abruf wieder aeltestes
		// zuerst. Sein eigener Stand geht mit auf 0, er zeigte sonst hinter
		// Datensaetze, die gerade erst nachkommen. Ein Geraet ohne vorgezogenen
		// Teil bekommt hier einen; `historyLocal` haelt fest, dass seine Monate
		// schon auf der Platte liegen und die Sicherung erlaubt bleibt.
		const priority = state.priority
			? { ...state.priority, seq: 0 }
			: { seq: 0, months: [monthKey(Date.now()), prevMonthKey()], historyLocal: state.seq > 0 };
		const rewound: SyncState = { seq: 0, priority };
		// Stand 0 heisst: es gibt nichts nachzuholen - frisch verknuepft, oder noch
		// nie abgeglichen. Nur der Merker war faellig. Der Nachlauf-Vermerk darf
		// hier NICHT gesetzt werden: sonst gilt das Konto als schon benutzt, und
		// der lokale Bestand faende nie den Weg hinauf.
		if (state.seq === 0) {
			await saveDevice({ ...info, priority, resyncGeneration: RESYNC_GENERATION });
			return rewound;
		}
		await saveDevice({ ...info, seq: 0, priority, resyncGeneration: RESYNC_GENERATION });
		this.#rewound = true;
		logInfo("Hole den Serverstand einmalig von vorne", { grund: "neue Datensatzart" });
		return rewound;
	}

	// ---------- Abgleich ----------

	/** Wann zuletzt die Ansichten neu gelesen wurden - siehe `#reloadIsDue`. */
	#lastReload = 0;

	/**
	 * Steht ein Neulesen an?
	 *
	 * Ausserhalb des Backfills immer. Waehrend er laeuft, hoechstens alle
	 * `BACKFILL_RELOAD_MS` - und am Ende, wenn er durch ist.
	 */
	#reloadIsDue(): boolean {
		const now = Date.now();
		if (!this.backfilling || now - this.#lastReload >= BACKFILL_RELOAD_MS) {
			this.#lastReload = now;
			return true;
		}
		return false;
	}

	/**
	 * Die naechste Portion Historie anstossen.
	 *
	 * Mit eigenem Timer: `syncSoon` traegt den Wunsch des Nutzers, und den darf
	 * eine Backfill-Runde nicht um zwei Sekunden nach hinten schieben.
	 */
	#continueBackfill(): void {
		if (!this.#engine) return;
		if (this.#backfillTimer) clearTimeout(this.#backfillTimer);
		this.#backfillTimer = setTimeout(() => {
			this.#backfillTimer = null;
			void this.syncNow();
		}, BACKFILL_GAP_MS);
	}

	/** Bald abgleichen. */
	syncSoon(delay = DEBOUNCE_MS): void {
		if (!this.#engine) return;
		if (this.#debounce) clearTimeout(this.#debounce);
		this.#debounce = setTimeout(() => void this.syncNow(), delay);
	}

	/**
	 * Abgleichen und dabei nachsehen, ob etwas nie hochgeladen wurde.
	 *
	 * Der Schreib-Haken sieht nur, was waehrend seiner Laufzeit geschrieben wird.
	 * Was vor dem Verknuepfen entstand oder mit einer verlorenen Outbox unterging,
	 * traegt keinen Stempel und faende sonst nie den Weg zum Server.
	 *
	 * Erst holen, dann vormerken: der frische Zeitstempel des ungestempelten
	 * Bestands gewaenne sonst jeden Vergleich und ueberschriebe das Konto.
	 */
	async syncWithFollowUp(): Promise<void> {
		this.#rewound = false;
		await this.syncNow();
		if (await this.#dataIsOurs()) {
			await rememberUnstamped();
		}
		await this.syncNow();
	}

	/**
	 * Gehoert der ungestempelte Bestand zu DIESEM Konto?
	 *
	 * Nach einem Kontowechsel auf dem Rechner liegen hier die Zeiten des vorigen
	 * Kontos. Sie bleiben - aber sie gehen nicht hoch. Ohne diese Frage haette
	 * jedes neue Konto den Bestand des vorigen geerbt.
	 */
	async #dataIsOurs(): Promise<boolean> {
		const info = await loadDevice();
		if (!info?.dataOwner || !info.accountFingerprint) return true;
		return info.dataOwner === info.accountFingerprint;
	}

	/**
	 * Ein anderes Fenster hat geschrieben - nachsehen und hochladen.
	 *
	 * Das Tray-Fenster hat einen eigenen Webview und damit einen eigenen
	 * Modulzustand; der Schreib-Haken laeuft dort nicht. Was es schreibt, traegt
	 * deshalb keinen Stempel und stuende ohne diesen Schritt nur lokal da.
	 */
	async followUp(): Promise<void> {
		if (!this.linked) return;
		if (!(await this.#dataIsOurs())) return;
		await rememberUnstamped();
		this.syncSoon(0);
	}

	/**
	 * Einen Monat holen, den der erste Abgleich noch nicht mitgebracht hat.
	 *
	 * Ist die Historie durch, kostet der Aufruf nichts - dann liegt ohnehin alles
	 * auf der Platte.
	 */
	async ensureMonthSynced(month: string): Promise<void> {
		if (!this.#engine || this.state !== "connected") return;
		const running = this.#engine.ensureMonthSynced(month);
		// Nur melden, wenn wirklich etwas laeuft: liegt der Monat schon vor, kaeme
		// sonst fuer einen Wimpernschlag ein Spinner, den niemand deuten kann.
		if (!this.#engine.isFetchingMonth(month) || this.fetchingMonths.includes(month)) {
			return running;
		}
		this.fetchingMonths = [...this.fetchingMonths, month];
		try {
			await running;
		} finally {
			this.fetchingMonths = this.fetchingMonths.filter((m) => m !== month);
		}
	}

	/**
	 * Zu welchen Monaten das Konto Daten hat - auch zu solchen, die hier noch
	 * nicht liegen.
	 *
	 * Waehrend der Backfill laeuft, kennt die Platte nur die vorgezogenen Monate;
	 * die Auswahl zeigte sonst ausgerechnet die alten Monate nicht an, die man
	 * anklicken muesste, damit sie geholt werden.
	 *
	 * Der Server nennt nur Kennungen. Welcher Monat dahintersteckt, rechnet dieses
	 * Geraet selbst aus - die Kennung ist deterministisch, und der Server erfaehrt
	 * dabei nichts, was er nicht ohnehin haette.
	 */
	async remoteMonths(): Promise<string[]> {
		if (!this.#api || !this.#key || this.state !== "connected") return [];
		const { buckets } = await this.#api.buckets();
		const known = new Set(buckets);
		const start = monthKey(Date.now());
		const found: string[] = [];
		for (let offset = 1 - REMOTE_MONTH_LOOKBACK; offset <= REMOTE_MONTH_LOOKAHEAD; offset++) {
			const month = shiftMonthKey(start, offset);
			if (known.has(await bucketFor(this.#key, month))) found.push(month);
		}
		return found;
	}

	/**
	 * Den Massen-Abruf abschliessen: kurz "fertig", dann weg.
	 *
	 * Nur wo vorher auch "wird geladen" stand - der Backfill zaehlt in
	 * `result.pulled` mit und liesse den Abschluss sonst jede Runde aufblitzen.
	 */
	#finishBulkSync(): void {
		// Steht der Abschluss schon, laeuft nur das Ende des Durchgangs hier ein
		// zweites Mal durch - Meldung und Toast bleiben, wo sie sind.
		if (this.bulkSync?.phase === "done") return;
		if (!this.bulkSync) {
			toast.dismiss("sync-bulk");
			return;
		}
		const pulled = this.bulkSync.pulled;
		this.bulkSync = { phase: "done", pulled };
		if (isTauri()) {
			toast.success(`${pulled} Einträge synchronisiert.`, { id: "sync-bulk" });
		}
		setTimeout(() => {
			if (this.bulkSync?.phase === "done") this.bulkSync = null;
		}, 1500);
	}

	async syncNow(): Promise<void> {
		if (!this.#engine || this.state !== "connected") return;
		this.phase = "running";
		try {
			const result = await this.#engine.sync();
			// Kam etwas an, war dieses Geraet nie leer - es wusste es nur noch
			// nicht. Der Willkommensbildschirm hat sich damit erledigt, und zwar
			// bevor jemand ihn ausfuellt und dabei die echten Einstellungen
			// ueberschreibt. Vor `firstSyncDone`, sonst blitzt er dazwischen auf.
			if (result && result.pulled > 0 && app.showOnboarding) {
				app.dismissOnboarding();
			}
			this.firstSyncDone = true;
			this.backfilling = this.#engine.backfilling;
			this.historyIncomplete = this.#engine.historyIncomplete;
			this.phase = "idle";
			this.lastSync = Date.now();
			this.#retryStep = 0;
			if (result) {
				this.lostEdits += result.lostEdits;
				if (result.pushed || result.pulled) {
					logInfo("Abgeglichen", result);
				}
				this.#finishBulkSync();
				// Die Historie kommt gedeckelt - fuenf Seiten je Runde. Ohne Anstoss
				// laege die naechste Portion beim Herzschlag: alle fuenf Minuten
				// tausend Saetze, und so lange bleiben Sicherung und Monatsauswahl
				// gesperrt.
				if (this.backfilling) this.#continueBackfill();
			} else {
				if (this.bulkSync?.phase === "pulling") this.bulkSync = null;
				toast.dismiss("sync-bulk");
			}
			// Der Bestand kann sich geaendert haben - die Ansichten haengen daran.
			// Waehrend die Historie laeuft, kommen die Runden im Sekundentakt und
			// betreffen fast immer Monate, die niemand offen hat: dann reicht es,
			// gelegentlich nachzuziehen, statt bei jeder Portion alles von der
			// Platte zu lesen und /me zu fragen.
			if (result && (result.pulled > 0 || result.pushed > 0) && this.#reloadIsDue()) {
				await app.reload();
				void this.accountInfo().catch(() => {});
				void notifyDataChanged({ from: "sync" });
			}
		} catch (e) {
			// Auch ein gescheiterter Versuch beantwortet die Frage "warten oder
			// anzeigen?": ohne Verbindung bleibt der Willkommensbildschirm sonst
			// fuer immer aus.
			this.firstSyncDone = true;
			this.bulkSync = null;
			toast.dismiss("sync-bulk");
			this.#onSyncError(e);
		}
	}

	#onSyncError(e: unknown): void {
		if (e instanceof ApiError && e.status === 401) {
			// Das Geraet wurde widerrufen oder das Token ist ungueltig. Weiter zu
			// versuchen hat keinen Zweck und wuerde nur Anfragen erzeugen.
			this.state = "error";
			this.phase = "error";
			this.message = "Dieses Gerät wurde vom Konto getrennt.";
			this.#closeStream();
			logWarn("Gerät ist nicht mehr berechtigt");
			return;
		}
		if (e instanceof ApiError && e.retryable) {
			this.phase = "offline";
			this.#scheduleRetry();
			return;
		}
		this.phase = "error";
		this.message = e instanceof Error ? e.message : "Abgleich fehlgeschlagen";
		logError("Abgleich fehlgeschlagen", e);
		this.#scheduleRetry();
	}

	#scheduleRetry(): void {
		if (this.#retry) clearTimeout(this.#retry);
		const waitMs = RETRY_MS[Math.min(this.#retryStep, RETRY_MS.length - 1)];
		this.#retryStep++;
		this.#retry = setTimeout(() => void this.syncNow(), waitMs);
	}

	// ---------- Weckruf-Kanal ----------

	#installNetworkListeners(): void {
		if (this.#listenersInstalled || typeof window === "undefined") return;
		this.#listenersInstalled = true;

		window.addEventListener("online", () => {
			logInfo("Netzwerkverbindung wieder verfügbar (online Event)");
			if (this.state === "connected") {
				this.#retryStep = 0;
				if (this.#retry) {
					clearTimeout(this.#retry);
					this.#retry = null;
				}
				if (this.phase === "offline") {
					this.phase = "idle";
				}
				// Stream nur neu aufbauen wenn er wirklich weg ist.
				if (!this.#stream || this.#stream.readyState === EventSource.CLOSED) {
					this.#openStream();
				}
				void this.syncNow();
			}
		});

		window.addEventListener("offline", () => {
			logWarn("Netzwerkverbindung unterbrochen (offline Event)");
			if (this.phase !== "running") {
				this.phase = "offline";
			}
		});

		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible") {
				this.onVisible();
			}
		});

		// Nur bei reinem Fenster-Fokus reagieren (z. B. Alt+Tab zwischen Fenstern),
		// nicht wenn das visibilitychange-Event ohnehin schon gefeuert hat.
		window.addEventListener("focus", () => {
			if (document.visibilityState === "visible") this.onVisible();
		});
	}

	/** Auf Aenderungen anderer Geraete hoeren. */
	#openStream(): void {
		this.#closeStream();
		if (typeof EventSource === "undefined" || !this.#api) return;

		// In der Desktop-Anwendung geht kein EventSource: sie weist sich mit einem
		// Token aus, und EventSource kann keine Kopfzeilen setzen. Stattdessen eine
		// Anfrage, die der Server offen haelt, bis sich etwas tut.
		if (isTauri()) {
			void this.#warteschleife();
			return;
		}

		try {
			this.#stream = new EventSource(this.#api.streamUrl(), { withCredentials: true });
			this.#stream.onopen = () => {
				if (this.phase === "offline") {
					this.phase = "idle";
				}
				this.#retryStep = 0;
			};
			this.#stream.addEventListener("change", (ev) => {
				const data = JSON.parse((ev as MessageEvent).data ?? "{}");
				// Den eigenen Weckruf ueberspringen: was dieses Geraet gerade
				// hochgeladen hat, muss es nicht wieder herunterladen.
				if (data.deviceId === this.#device) return;
				this.syncSoon(300);
			});
			this.#stream.onerror = () => {
				if (this.phase !== "running") this.phase = "offline";
				// Falls EventSource geschlossen wurde (z. B. Netzwerk-Drop auf Mobile):
				if (this.#stream && this.#stream.readyState === EventSource.CLOSED) {
					this.#closeStream();
					this.#scheduleRetry();
				}
			};
		} catch (e) {
			logWarn("Weckruf-Kanal nicht verfügbar, nutze langsamen Takt", e);
			this.#startHeartbeat();
		}
	}

	/**
	 * Die Warteschleife: fragen, warten lassen, abgleichen, von vorn.
	 *
	 * Der Server haelt jede Anfrage bis zu 25 Sekunden offen und antwortet, sobald
	 * ein anderes Geraet geschrieben hat. Damit ist die Desktop-Anwendung genauso
	 * schnell wie der Browser mit seinem Stream, ohne dass ein Token in eine
	 * Adresse wandern muesste.
	 */
	async #warteschleife(): Promise<void> {
		const abort = new AbortController();
		this.#wait = abort;
		// Der langsame Takt bleibt als Netz darunter: faellt die Schleife aus,
		// laeuft der Abgleich trotzdem weiter.
		this.#startHeartbeat();

		let errorCount = 0;
		while (this.#wait === abort && this.state === "connected") {
			try {
				const knownSeq = (await loadDevice())?.seq ?? 0;
				const answer = await this.#api!.waitForChange(knownSeq, abort.signal);
				if (this.#wait !== abort) return;
				errorCount = 0;
				if (answer.changed) this.syncSoon(50);
			} catch (e) {
				if (abort.signal.aborted) return;
				// Nach einem Fehlschlag wachsend warten, sonst haemmert eine
				// abgerissene Verbindung gegen den Server.
				errorCount++;
				const pause = RETRY_MS[Math.min(errorCount - 1, RETRY_MS.length - 1)];
				logWarn("Weckruf-Schleife unterbrochen", e);
				await new Promise((r) => setTimeout(r, pause));
			}
		}
	}

	/** Der langsame Takt fuer alles, was keinen Kanal hat. */
	#startHeartbeat(): void {
		this.#stopHeartbeat();
		this.#heartbeat = setInterval(() => void this.syncNow(), HEARTBEAT_MS);
	}

	#stopHeartbeat(): void {
		if (this.#heartbeat) clearInterval(this.#heartbeat);
		this.#heartbeat = null;
	}

	/** Das Fenster kommt in den Vordergrund oder wird wieder aktiv. */
	onVisible(): void {
		if (this.state === "connected") {
			if (this.phase === "offline" || !this.#stream) {
				this.#retryStep = 0;
				this.#openStream();
			}
			this.syncSoon(0);
		}
	}

	#closeStream(): void {
		this.#stream?.close();
		this.#stream = null;
		this.#wait?.abort();
		this.#wait = null;
		this.#stopHeartbeat();
	}

	// ---------- Konto von hier aus anlegen ----------

	/** Ein neues Konto anlegen - von diesem Geraet aus, ohne Umweg ueber den Browser. */
	async createAccount(
		serverUrl: string,
		displayName: string,
		label: string,
		opts: { invite?: string; email?: string } = {}
	): Promise<string> {
		const url = serverUrl.replace(/\/+$/, "");
		const { registerFromDevice } = await import("./enroll");
		const r = await registerFromDevice(url, displayName, label, opts);
		await this.#persistLink(url, r.deviceToken, r.key, r.displayName);
		return r.recoveryPhrase;
	}

	/** Ein Konto allein mit der Wiederherstellungs-Phrase zurueckholen. */
	async recoverWithPhrase(serverUrl: string, phrase: string, label: string): Promise<void> {
		const url = serverUrl.replace(/\/+$/, "");
		const { recoverWithPhrase } = await import("./enroll");
		const r = await recoverWithPhrase(url, phrase, label);
		await this.#persistLink(url, r.deviceToken, r.key, r.displayName);
	}

	// ---------- Koppeln: dieses Geraet ist neu ----------

	/** Schritt 1: einen Kopplungscode holen. Nur im Speicher - ueberdauert keinen Neustart. */
	#pairing: {
		pair: CryptoKeyPair;
		code: string;
		url: string;
		/** Weist beim Abholen aus. Nur hier im Speicher, nie im Link, nie am Bildschirm. */
		claimSecret: string;
	} | null = null;

	async startPairing(serverUrl: string, label: string): Promise<string> {
		const url = serverUrl.replace(/\/+$/, "");
		const api = new Api({ baseUrl: url, fetchFn: platformFetch });
		const pair = await createPairingKeyPair();
		const raw = await exportPairingPublicKey(pair);
		const publicKey = toBase64(raw);

		// Der Code wird HIER gerechnet, aus dem eigenen oeffentlichen Schluessel -
		// er ist dessen Abdruck (siehe pairingCode). Der Server bekommt ihn nur
		// mitgeteilt und legt den Vorgang darunter ab.
		const code = await pairingCode(raw);

		// Der Code ist zum Vergleichen da und steht deshalb offen herum. Das
		// Abholen des Geraete-Tokens haengt an diesem Geheimnis, das dieses Geraet
		// behaelt - sonst genuegte ein mitgelesener Code.
		const { secret: claimSecret, hash: claimHash } = await createClaimSecret();
		const answer = await api.pairStart(publicKey, label, code, claimHash);

		// Und was er zurueckgibt, muss dasselbe sein. Ein Server, der einen anderen
		// Code herausgibt, brauchte ihn nur, um ihn auf den Bildschirm zu bekommen:
		// der Mensch traegt ihn drueben ein, drueben liegt dann ein Schluessel, der
		// zu DIESEM Code passt - und das waere nicht mehr unserer.
		if (answer.code !== code) {
			throw new Error("Der Server hat einen anderen Kopplungscode zurückgegeben.");
		}

		this.#pairing = { pair, code, url, claimSecret };
		return code;
	}

	/** Schritt 3: nachsehen, ob jemand bestaetigt hat. */
	async checkPairing(): Promise<boolean> {
		if (!this.#pairing) return false;
		const { pair, code, url, claimSecret } = this.#pairing;
		const api = new Api({ baseUrl: url, fetchFn: platformFetch });
		const answer = await api.pairClaim(code, claimSecret);
		if (answer.pending) return false;

		// Das Paket oeffnen - das kann nur dieses Geraet, mit seinem privaten
		// Schluessel. Der Server hatte nie mehr als Chiffrat in der Hand.
		const wrap = JSON.parse(answer.wrappedKey) as {
			salt: string;
			iv: string;
			wrapped: string;
			ephemeralPublicKey: string;
		};
		const key = await unwrapForDevice(
			{
				kind: "device",
				salt: fromBase64(wrap.salt),
				iv: fromBase64(wrap.iv),
				wrapped: fromBase64(wrap.wrapped),
				ephemeralPublicKey: fromBase64(wrap.ephemeralPublicKey)
			},
			pair.privateKey
		);

		await this.#persistLink(url, answer.deviceToken, key);
		this.#pairing = null;
		return true;
	}

	cancelPairing(): void {
		this.#pairing = null;
	}

	// ---------- Koppeln: dieses Geraet bestaetigt ein anderes ----------

	/** Einen Code bestaetigen. */
	async approvePairing(code: string): Promise<string> {
		if (!this.#api || !this.#key) throw new Error("Dieses Gerät ist nicht verknüpft");
		const typed = normalizePairingCode(code);
		const { publicKey, label } = await this.#api.pairLookup(typed);

		// Wirft, wenn unter diesem Code ein anderer Schluessel liegt als der, dessen
		// Abdruck er ist. Dann wird NICHTS verpackt: wer immer den Schluessel
		// hinterlegt hat, bekaeme sonst den Tresorschluessel.
		const raw = await checkedPairingKey(typed, publicKey).catch((e) => {
			logWarn("Kopplung abgebrochen: hinterlegter Schlüssel passt nicht zum Code");
			throw e;
		});

		const { wrapForDevice } = await import("../crypto/vault");
		const wrap = await wrapForDevice(this.#key, raw);
		await this.#api.pairApprove(typed, JSON.stringify(serializeWrap(wrap)));
		logInfo("Gerät gekoppelt", { label });
		void this.syncWithFollowUp();
		return label;
	}

	/** Nach Registrierung oder Anmeldung im Browser: die Verknuepfung uebernehmen. */
	async linkWithSession(url: string, key: CryptoKey, name: string): Promise<void> {
		await this.#persistLink(url.replace(/\/+$/, ""), null, key, name);
	}

	// ---------- Verknuepfung ablegen und loesen ----------

	async #persistLink(
		url: string,
		token: string | null,
		key: CryptoKey,
		name = ""
	): Promise<void> {
		this.#key = key;
		this.#device = await deviceId();
		const raw = toBase64(new Uint8Array(await exportVaultKey(key)));
		const protectedKey = await protectSecret(raw);
		// Im Browser gibt es kein Geraete-Token: dort weist das Sitzungs-Cookie
		// aus. Der Tresorschluessel wird trotzdem abgelegt, damit die Anwendung
		// nach einem Neuladen nicht wieder nach der Anmeldung fragen muss.
		const protectedToken = token ? await protectSecret(token) : null;

		const info = (await loadDevice()) ?? { id: this.#device };

		// Der erste Abgleich zieht vor, was der Mensch sofort sieht. Ohne das kaeme
		// der laufende Monat zuletzt: der Server liefert nach Stand aufsteigend,
		// also die aeltesten Eintraege zuerst.
		const startState: SyncState = {
			seq: 0,
			priority: { seq: 0, months: [monthKey(Date.now()), prevMonthKey()] }
		};

		// Wessen Konto ist das? Zwei Konten haben verschiedene Tresorschluessel,
		// also verschiedene Nachweise.
		const fingerprint = await vaultProof(key);
		const switched = Boolean(info.accountFingerprint && info.accountFingerprint !== fingerprint);

		// Im Browser gibt es keinen Bestand ohne Konto - man kommt ohne Anmeldung
		// gar nicht hinein. Was hier liegt, ist die Kopie IRGENDEINES Kontos. Laesst
		// sich nicht beweisen, dass es dieses ist, kommt es weg; der Server hat es.
		// Auf dem Rechner sind die Zeiten die Sache des Menschen: sie bleiben, gehen
		// aber nicht hoch (siehe dataOwner).
		const foreignCopy = !isTauri() && info.accountFingerprint !== fingerprint;
		if (foreignCopy) {
			await clearAccountData();
			app.clearLocalData();
			logInfo("Kontowechsel / Neuverknüpfung: lokale Kopie entfernt");
		}

		// Die Merkliste gehoert IMMER dem vorigen Konto - auf beiden Plattformen.
		// Ohne diese Zeile laedt sie der naechste Abgleich ins neue Konto: `#pushAll`
		// liest die Outbox, nicht den Stempel.
		if (switched || foreignCopy) await clearOutbox();

		// Wem der Bestand gehoert: nach einem Wechsel weiterhin dem alten Konto
		// (dann bleibt er hier liegen), sonst diesem. Wer noch nie ein Konto hatte,
		// dessen Bestand ist der eigene und gehoert hoch.
		const dataOwner = switched && isTauri() ? info.dataOwner : fingerprint;

		await saveDevice({
			...info,
			id: this.#device,
			serverUrl: url,
			token: protectedToken?.data,
			vaultKey: protectedKey.data,
			protected: protectedKey.protected && (protectedToken?.protected ?? true),
			accountName: name || info.accountName,
			accountFingerprint: fingerprint,
			dataOwner,
			seq: 0,
			priority: startState.priority
		});
		this.name = name || this.name;

		this.serverUrl = url;
		this.secretsProtected = protectedKey.protected;
		this.hasDeviceToken = token !== null;
		this.state = "connected";
		await this.#startEngine(url, token, startState);
		void this.syncWithFollowUp();
	}

	/** Nachsehen, was am Konto haengt - vor allem, wie viele Geraete und die Verwalterrolle. */
	async accountInfo(): Promise<AccountInfo | null> {
		if (!this.#api) return null;
		const info = await this.#api.me();
		this.isAdmin = info.isAdmin;
		if (info.displayName && info.displayName !== info.userId) {
			this.name = info.displayName;
		}
		// Falls lokal ein Name aus "Bericht & E-Mail" hinterlegt ist, der Server ihn aber noch nicht hat:
		const localName = app.settings.senderName.trim();
		if (localName && localName !== info.displayName && (info.displayName === info.userId || !info.displayName)) {
			void this.updateDisplayName(localName);
		}
		return info;
	}

	/** Den Anzeigenamen auf dem Server und lokal aktualisieren. */
	async updateDisplayName(name: string): Promise<string> {
		const trimmed = name.trim();
		if (!trimmed) return this.name;
		if (this.#api && this.linked) {
			try {
				const res = await this.#api.updateMe({ displayName: trimmed });
				this.name = res.displayName;
				const info = await loadDevice();
				if (info) await saveDevice({ ...info, accountName: res.displayName });
				if (app.settings.senderName !== res.displayName) {
					await app.updateSettings({ senderName: res.displayName });
				}
				return res.displayName;
			} catch (e) {
				logWarn("Anzeigename konnte nicht aktualisiert werden", e);
			}
		}
		this.name = trimmed;
		if (app.settings.senderName !== trimmed) {
			await app.updateSettings({ senderName: trimmed });
		}
		return trimmed;
	}

	// ---------- Passkeys ----------
	//
	// Nur im Browser: ein Passkey haengt an der Domain, und die Desktop-Anwendung
	// hat keine. Dort ist der Weg zu einem zweiten Geraet die Kopplung.

	async passkeys(): Promise<Passkey[]> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return (await this.#api.passkeys()).passkeys;
	}

	/** Einen weiteren Passkey anlegen. */
	async addPasskey(label: string): Promise<{ prfAvailable: boolean }> {
		if (!this.#key) throw new Error("Das Konto ist nicht entsperrt");
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		const { addPasskey } = await import("./enroll");
		const result = await addPasskey(this.#api, this.#key, label);
		return { prfAvailable: result.prfAvailable };
	}

	/** Einen vorhandenen Passkey nachtraeglich die Daten oeffnen lassen - ohne die 24 Woerter. */
	async repairPasskeyWrap(credentialId?: string): Promise<boolean> {
		if (!this.#key) throw new Error("Das Konto ist nicht entsperrt");
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		const { ensurePasskeyWrap } = await import("./enroll");
		return ensurePasskeyWrap(this.#api, this.#key, credentialId);
	}

	/** Die Kennung dieses Geraets - damit die Liste das eigene erkennt. */
	get thisDeviceId(): string {
		return this.#device;
	}

	/** Ein anderes Geraet vom Konto trennen. Es kommt danach nicht mehr hinein. */
	async revokeDevice(id: string): Promise<void> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		if (id === this.#device) throw new Error("Das ist dieses Gerät – dafür gibt es „Entkoppeln“.");
		await this.#api.revokeDevice(id);
	}

	async renamePasskey(id: string, label: string): Promise<void> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		await this.#api.renamePasskey(id, label);
	}

	async removePasskey(id: string): Promise<void> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		await this.#api.removePasskey(id);
	}

	// ---------- Verwaltung ----------
	//
	// Nur fuer Verwalter, und der Server entscheidet das - nicht dieses Modul.
	// Hier steht bloss der Draht dorthin.

	async invites(): Promise<{
		invites: Invite[];
		envInvitesConfigured: boolean;
		envInvitesActive: boolean;
		openRegistration: boolean;
	}> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		const res = await this.#api.invites();
		return {
			invites: res.invites,
			envInvitesConfigured: Boolean(res.envInvitesConfigured),
			envInvitesActive: res.envInvitesActive ?? true,
			openRegistration: Boolean(res.openRegistration)
		};
	}

	async setOpenRegistration(open: boolean): Promise<boolean> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		const res = await this.#api.setOpenRegistration(open);
		return res.openRegistration;
	}

	async setEnvInvites(active: boolean): Promise<boolean> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		const res = await this.#api.setEnvInvites(active);
		return res.envInvitesActive;
	}

	async createInvite(opts: { note?: string; validDays?: number } = {}): Promise<Invite> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return this.#api.createInvite(opts);
	}

	async revokeInvite(code: string): Promise<void> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		await this.#api.revokeInvite(code);
	}

	async backups(): Promise<BackupInfo[]> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		const res = await this.#api.backups();
		return res.backups;
	}

	async createBackup(): Promise<BackupInfo> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		const res = await this.#api.createBackup();
		return res.backup;
	}

	async restoreBackup(name: string): Promise<{ ok: boolean; restored: string; preRestoreBackup: string }> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return this.#api.restoreBackup(name);
	}

	async deleteBackup(name: string): Promise<void> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		await this.#api.deleteBackup(name);
	}

	async stats(days = 30): Promise<ServerStats> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return this.#api.stats(days);
	}

	/**
	 * Dem eigenen Server anonym melden, dass die Anwendung heute lief. Wirft nie.
	 *
	 * Ueber `#api` und nicht mit einem eigenen Aufruf: nur so weist sich die
	 * Meldung genauso aus wie jeder andere Serveraufruf - mit dem Geraetetoken,
	 * sonst mit dem Cookie. Die PWA hat keinen Schluessel aus dem Build und
	 * kaeme sonst gar nicht durch.
	 */
	async sendUsagePing(): Promise<PingResult> {
		if (!this.#api) return "retry";
		try {
			await this.#api.telemetry({
				deviceId: await deviceId(),
				version: APP_VERSION,
				platform: detectPlatform()
			});
			return "sent";
		} catch (e) {
			return classifyPingFailure(e instanceof ApiError ? e.status : 0);
		}
	}

	/**
	 * Abmelden: die Sitzung beim Server beenden und die Verknuepfung hier vergessen.
	 *
	 * Die erfassten Zeiten bleiben liegen - abmelden ist kein Loeschen. Der Passkey
	 * bleibt am Konto, die naechste Anmeldung geht damit wieder auf.
	 */
	async logout(): Promise<void> {
		try {
			await this.#api?.logout();
		} catch (e) {
			// Eine abgelaufene Sitzung laesst sich nicht noch einmal beenden. Lokal
			// vergessen muss trotzdem gehen, sonst sitzt jemand an einem fremden
			// Rechner fest, an dem er sich gerade abmelden wollte.
			logWarn("Abmelden beim Server fehlgeschlagen", e);
		}
		await this.unlink();
	}

	/** Die Verknuepfung loesen. */
	async unlink(opts: UnlinkOptions = {}): Promise<DeleteSummary | null> {
		let summary: DeleteSummary | null = null;

		if (opts.deleteRemote || opts.revokeSelf) {
			if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
			// Zuerst der Server, solange Zugang und Token noch stehen. Danach ist
			// beides weg und der Vorgang liesse sich nicht mehr nachholen.
			if (opts.deleteRemote) {
				summary = await this.#api.deleteAccount(await this.#bestaetigung());
			} else {
				await this.#api.revokeDevice();
			}
		}

		await this.#forgetLocally();
		// Erst nachdem der Zugang wirklich weg ist: die Stempel abstreifen. Vorher
		// waere ein Abbruch mittendrin der schlechteste aller Zustaende - Daten
		// ohne Fassungsnummern, aber ein Konto, das sie noch erwartet.
		const unlinked = await detachLocalData();
		// Im Browser war der Bestand nur eine Kopie des Servers. Bliebe er liegen,
		// sieht der naechste Mensch an diesem Rechner die Zeiten des vorigen.
		if (!isTauri()) {
			await clearAccountData();
			app.clearLocalData();
		}
		logInfo("Verknüpfung gelöst", { ...opts, ...unlinked });
		return summary;
	}

	/** Den Menschen bestaetigen lassen - mit dem Passkey, nicht mit einem Haken. */
	async #bestaetigung(): Promise<{ challengeId: string; response: unknown } | undefined> {
		if (isTauri()) return undefined;
		const { startAuthentication } = await import("@simplewebauthn/browser");
		const { challengeId, options } = await this.#api!.confirmStart();
		const response = await startAuthentication({
			optionsJSON: options as Parameters<typeof startAuthentication>[0]["optionsJSON"]
		});
		return { challengeId, response };
	}

	/** Alles abstellen und die Kontodaten dieses Geraets vergessen. */
	async #forgetLocally(): Promise<void> {
		// Zuerst die Engine, und zwar ohne ein einziges await davor: eine laufende
		// Runde antwortet noch, wenn hier laengst aufgeraeumt ist. Ohne stop()
		// spielt sie die Daten des alten Kontos wieder ein, und ihr `saveState`
		// traegt den Tresorschluessel in die gerade geleerte device.json zurueck.
		this.#engine?.stop();
		this.#engine = null;

		// Dann der Schluessel - vor allem, was fremden Code ruft (Timer, Haken,
		// Oberflaeche). Wirft dort etwas, laege er sonst weiter im Browser, und
		// mit ihm die Adresse des Servers.
		const info = await loadDevice();
		// Nur die Kontodaten loeschen, nicht die Geraetekennung: die soll
		// dieselbe bleiben, falls jemand erneut koppelt.
		if (info) await saveDevice({ id: info.id });

		this.#closeStream();
		if (this.#debounce) clearTimeout(this.#debounce);
		if (this.#backfillTimer) clearTimeout(this.#backfillTimer);
		if (this.#retry) clearTimeout(this.#retry);
		stopTracking();
		setChangeListener(null);
		this.backfilling = false;
		this.historyIncomplete = false;
		this.firstSyncDone = false;
		this.fetchingMonths = [];
		app.setMonthFetcher(null);
		this.#api = null;
		this.#key = null;
		// Den Prefetch-Puffer leeren: er gehoert dem abgemeldeten Konto. Sonst
		// koennte ein schneller Re-Login in denselben 30-Sekunden-Fenstern Name,
		// E-Mail und Geraete-Labels des vorigen Nutzers sehen.
		this.#logoutHook?.();
		this.state = "off";
		this.phase = "idle";
		this.serverUrl = "";
		this.name = "";
		this.message = "";
		this.isAdmin = false;
		this.hasDeviceToken = false;
	}

	/** Beim Schliessen des Fensters. */
	dispose(): void {
		this.#closeStream();
		this.#stopHeartbeat();
		if (this.#debounce) clearTimeout(this.#debounce);
		if (this.#retry) clearTimeout(this.#retry);
	}
}

/** Eine Verpackung als JSON - Bytes werden zu base64. */
function serializeWrap(wrap: KeyWrap): Record<string, string> {
	return {
		kind: wrap.kind,
		salt: toBase64(wrap.salt),
		iv: toBase64(wrap.iv),
		wrapped: toBase64(wrap.wrapped),
		...(wrap.ephemeralPublicKey
			? { ephemeralPublicKey: toBase64(wrap.ephemeralPublicKey) }
			: {})
	};
}

export const account = new AccountState();
export { createVaultKey };
