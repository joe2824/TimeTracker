// Das Konto, wie die Oberfläche es sieht.
import { app } from "../app.svelte";
import { logError, logInfo, logWarn, clearLogs } from "../log";
import {
	clearAccountData,
	clearOutbox,
	deleteTimeReport,
	loadDevice,
	loadEntries,
	loadTimeReport,
	saveEntries,
	saveTimeReport,
	getLocalEncryptionKey,
	readProtectedVaultKey,
	setLocalEncryptionKey,
	updateDevice,
	type DeviceInfo
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
import {
	Api,
	ApiError,
	type AccountInfo,
	type BackupInfo,
	type DeleteSummary,
	type Invite,
	type Passkey,
	type ServerStats,
	type TeamActivity,
	type TeamActivityInput,
	type TeamAdminInfo,
	type TeamInfo,
	type TeamInvite,
	type TeamMemberInfo,
	type TeamReportStatus
} from "./api";

import { detachLocalData } from "./detach";
import { monthKey, prevMonthKey, shiftMonthKey } from "../time/time";
import { SyncEngine, type StaleTimerSplitInfo, type SyncOutcome, type SyncState } from "./engine";
import {
	createPairingKeyPair,
	createVaultKey,
	exportPairingPublicKey,
	checkedPairingKey,
	exportVaultKey,
	importVaultKey,
	isExportable,
	normalizePairingCode,
	pairingCode,
	bucketFor,
	createClaimSecret,
	toBase64,
	unwrapForDevice,
	vaultProof,
	type VaultKey
} from "../crypto/vault";
import { toast } from "svelte-sonner";
import { protectSecret, unprotectSecret } from "../platform/secrets";
import { clearLocalVaultKey, loadLocalVaultKey, saveLocalVaultKey } from "../platform/keyStore";
import type { PrfFailure } from "./enroll";
import { isTauri } from "../platform/env";
import { usingBrowserStorage } from "../platform/fs";
import { platformFetch } from "../platform/http";
import { notifyDataChanged } from "../platform/windows";
import { APP_VERSION, DEFAULT_SERVER, TELEMETRY_KEY } from "../defaults";
import { classifyPingFailure, detectPlatform, type PingResult } from "../analytics";

export type LinkState = "off" | "connecting" | "connected" | "error";

/** Wie weit das Entkoppeln gehen soll - siehe `AccountState.unlink`. */
export interface UnlinkOptions {
	/** Den Zugang dieses Geräts auch beim Server beenden. */
	revokeSelf?: boolean;
	/** Das ganze Konto auflösen, samt aller Serverdaten. */
	deleteRemote?: boolean;
}

/** Wie es dem Abgleich gerade geht - genau das, was die Oberfläche zeigt. */
export type SyncPhase = "idle" | "running" | "offline" | "error";

/**
 * Wie lange nach einer Änderung gewartet wird, bevor hochgeladen wird.
 *
 * Kurz genug, dass ein Timer-Start sofort drüben ist; lang genug, dass Tippen
 * in einer Notiz nicht jede Taste einzeln hochlädt.
 */
const DEBOUNCE_MS = 400;

/** Abstand zwischen zwei Verbindungsversuchen, wachsend (maximal 30s). */
const RETRY_MS = [1_000, 3_000, 5_000, 10_000, 20_000, 30_000];

/**
 * Wie weit `remoteMonths` zurückschaut.
 *
 * Fünf Jahre. Die Kennungen sind HMACs, die dieses Gerät selbst rechnet -
 * sechzig Stück kosten nichts.
 */
const REMOTE_MONTH_LOOKBACK = 60;

/**
 * Wie weit `remoteMonths` vorausschaut.
 *
 * Urlaub wird im Voraus gebucht, oft bis ins nächste Jahr. Ohne den Blick nach
 * vorn fehlten genau diese Monate in der Auswahl, solange die Historie läuft.
 */
const REMOTE_MONTH_LOOKAHEAD = 12;

/** Der langsame Takt, wo es keinen Weckruf-Kanal gibt. */
const HEARTBEAT_MS = 5 * 60 * 1000;

/** Pause zwischen zwei Portionen Historie. */
const BACKFILL_GAP_MS = 2000;

/** Wie oft während des Backfills höchstens neu gelesen wird. */
const BACKFILL_RELOAD_MS = 5_000;

/**
 * Hochzählen, sobald eine neue Datensatzart hinzukommt.
 *
 * 1 = die eingelesenen Reports (timereport).
 *
 * Der Stand `seq` läuft über ALLES, was der Server hat - auch über Arten, die
 * die damals laufende Fassung nicht kannte und deshalb stillschweigend
 * übergangen hat. Die sind für dieses Gerät für immer weg, denn der nächste
 * Abruf beginnt hinter ihnen. Ein Wechsel dieser Zahl lässt jedes Gerät
 * einmalig von vorne holen; das Zusammenführen ändert dabei nichts an dem, was
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
	/** Ob Schlüssel und Token vom Betriebssystem geschützt sind. */
	secretsProtected = $state<boolean>(false);
	/** Wie viele eigene Änderungen beim Zusammenführen unterlegen sind. */
	lostEdits = $state<number>(0);
	/**
	 * Mitternachts-Teilungen, die stehen geblieben sind, weil ein anderes Gerät
	 * denselben Lauf inzwischen frueher beendet hat. Siehe StaleTimerSplitDialog.
	 */
	staleTimerSplits = $state<StaleTimerSplitInfo[]>([]);
	/** Darf dieses Konto Einladungen vergeben? */
	isAdmin = $state<boolean>(false);
	/** Weist sich dieses Gerät mit einem eigenen Token aus - oder mit einem Cookie? */
	hasDeviceToken = $state<boolean>(false);
	/**
	 * Der Passkey dieses Browsers - null, solange keiner benutzt wurde.
	 *
	 * Ein Konto kann mehrere Passkeys haben. Welcher davon hier liegt, verrät
	 * die Kontoliste nicht; nur diese Kennung sagt, welcher Eintrag der eigene
	 * ist.
	 */
	passkeyId = $state<string | null>(null);
	/**
	 * Ein Kopplungscode, der über einen "timetracker://"-Link hereinkam.
	 *
	 * Liegt hier und nicht in der Karte: der Link trifft das Fenster, die Karte
	 * ist zu dem Zeitpunkt vielleicht gar nicht aufgebaut. Wer ihn abholt, räumt
	 * ihn weg.
	 */
	pairCodeFromLink = $state<string>("");
	/**
	 * Ein `pair?server=`-Link kam an: der Browser bittet diese Anwendung, selbst
	 * eine Kopplung zu beginnen. Traegt die Serveradresse, keinen Code - den kann
	 * nur diese Anwendung erzeugen, er ist der Abdruck ihres Geraeteschluessels.
	 */
	pairStartRequest = $state<string>("");
	/** Fortschritt des aktuellen Synchronisationsvorgangs (z.B. wie viele Datensätze geladen wurden). */
	syncProgress = $state<{
		phase: "idle" | "pulling" | "pushing";
		pulled: number;
		pushed: number;
		/** Historie im Hintergrund - siehe SyncProgress. */
		background?: boolean;
	} | null>(null);

	/**
	 * Ob noch ältere Monate nachkommen.
	 *
	 * Gespiegelt statt durchgereicht: der Zustand im Abgleich ist kein `$state`,
	 * die Oberfläche bekäme eine Änderung daran sonst nie mit.
	 */
	backfilling = $state(false);
	/**
	 * Ob lokal wirklich Monate FEHLEN - daran hängen die Sperren für Sicherung
	 * und Einspielen.
	 *
	 * Ein Gerät, das nach einem Nachlauf nur alles noch einmal holt, hat den
	 * Bestand längst: dort wäre eine Sicherung vollständig, und sie zu sperren
	 * wäre ein Fehlalarm.
	 */
	historyIncomplete = $state(false);
	/**
	 * Ob dieses Gerät seit dem Start einmal abgeglichen hat - erfolgreich oder
	 * gescheitert.
	 *
	 * Bis dahin ist unklar, ob das Konto schon Daten hat. Der
	 * Willkommensbildschirm wartet darauf: ein frisch gekoppeltes Gerät ist
	 * lokal leer und sähe sonst "Willkommen", während die Einträge gerade
	 * hereinkommen.
	 */
	firstSyncDone = $state(false);
	/** Monate, die gerade vom Server nachgeholt werden - die Auswahl zeigt es an. */
	fetchingMonths = $state<string[]>([]);
	/**
	 * Massen-Abruf, allein für die Desktop-Meldung (Toast).
	 *
	 * Im Browser hängt die Anzeige an `syncProgress`, nicht hieran.
	 */
	bulkSync = $state<{ phase: "pulling" | "done"; pulled: number } | null>(null);
	/** Ob die Initialisierung des Kontos (Lesen lokaler Zugangsdaten) abgeschlossen ist. */
	ready = $state<boolean>(false);

	#api: Api | null = null;
	#engine: SyncEngine | null = null;
	#key: VaultKey | null = null;
	#stream: EventSource | null = null;
	#debounce: ReturnType<typeof setTimeout> | null = null;
	/** Eigener Takt für die Historie - der geteilte Entpreller gehört dem Nutzer. */
	#backfillTimer: ReturnType<typeof setTimeout> | null = null;
	#retry: ReturnType<typeof setTimeout> | null = null;
	#retryStep = 0;
	#device = "";
	#heartbeat: ReturnType<typeof setInterval> | null = null;
	#listenersInstalled = false;
	/** Läuft eine Weckruf-Schleife? Der Abbruch beendet auch die offene Anfrage. */
	#wait: AbortController | null = null;
	/** Wurde der Stand gerade zurückgesetzt? Siehe #rewindForNewKinds. */
	#rewound = false;
	/**
	 * Wird beim Abmelden aufgerufen - von aussen registriert, um einen Kreis-Import
	 * zu vermeiden (prefetch importiert account, account darf prefetch nicht importieren).
	 */
	#logoutHook: (() => void) | null = null;

	/** Einen Haken für das Abmelden setzen. Derzeit: prefetch-Puffer leeren. */
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

	/**
	 * Der zuletzt hinterlegte Schlüssel - für den Wiedereinstieg beim Start und
	 * nach einer abgelaufenen Sitzung (`unlockWithStoredKey`).
	 *
	 * Auf dem Rechner aus `device.json` (echter Schutz durchs Betriebssystem),
	 * im Browser aus der eigenen, nicht-exportierbaren Ablage
	 * (`platform/keyStore.ts`) - dort liegt seit diesem Umbau kein lesbarer
	 * Schlüssel mehr in `device.json`.
	 */
	async #loadStoredKey(info: DeviceInfo): Promise<VaultKey | null> {
		// Welche Ablage gilt, nicht welche Hülle läuft: Tests laufen mit
		// isTauri() === false, ohne je useBrowserStorage() aufzurufen, und müssen
		// dabei die Datei-Ablage (device.json) treffen, nicht IndexedDB.
		if (!usingBrowserStorage()) return readProtectedVaultKey(info, true);
		// preloadLocalEncryptionKey() (app.init(), läuft vorher) hat den
		// Schlüssel schon geholt - hier erst den bereits geladenen Stand nehmen,
		// kein zweiter IndexedDB-Zugriff für denselben Schlüssel. Der direkte
		// Versuch bleibt als Rücklage, falls dieser Aufruf einmal ohne
		// vorheriges app.init() läuft (z.B. in Tests).
		return getLocalEncryptionKey() ?? (await loadLocalVaultKey());
	}

	/**
	 * Den lokalen Bestand vollständig aufgeben - Dateien UND, im Browser, den
	 * abgelegten Schlüssel. Von zwei Stellen gebraucht (kein verknüpftes Konto
	 * beim Start, `unlink()`), deshalb hier gebündelt statt zweimal hingeschrieben.
	 */
	async #wipeLocalData(): Promise<void> {
		await clearAccountData();
		if (usingBrowserStorage()) {
			// Fehlschlag hier darf die restliche Aufraeumung nicht abbrechen - sonst
			// ueberleben Protokolle und die Sicherung unten das Abmelden auf einem
			// geteilten Rechner, obwohl das Konto serverseitig schon weg ist.
			await clearLocalVaultKey().catch((e) => logWarn("Lokaler Schluessel beim Abmelden nicht loeschbar", e));
			setLocalEncryptionKey(null);
			// Die Protokolle liegen neben dem Datenordner und ueberstanden das
			// Abmelden deshalb. Darin stehen Serveradresse, Geraetekennungen und
			// wann welches Konto verknuepft war - auf einem geteilten Rechner liest
			// das der Naechste. Auf dem Rechner bleiben sie: dort gehoert das Geraet
			// dem Menschen, und sie sind die einzige Diagnose, die er hat.
			await clearLogs().catch(() => {});
			await import("../report/backup")
				.then((m) => m.clearSnapshots())
				.catch(() => {});
		}
		app.clearLocalData();
	}

	/** Beim Programmstart: falls ein Konto verknüpft ist, alles hochfahren. */
	async init(): Promise<void> {
		try {
			const info = await loadDevice();
			const storedKey = info ? await this.#loadStoredKey(info) : null;
			// Ohne Adresse oder Schlüssel gibt es nichts zu verbinden. Das Token darf
			// fehlen: im Browser weist das Sitzungs-Cookie aus.
			if (!info?.serverUrl || !storedKey) {
				if (!isTauri()) {
					// Im Browser ohne verknüpftes Konto: keine Altlasten im Speicher belassen
					await this.#wipeLocalData();
				}
				return;
			}

			this.serverUrl = info.serverUrl;
			this.name = info.accountName ?? "";
			this.secretsProtected = info.protected ?? false;
			this.passkeyId = info.passkeyId ?? null;
			this.state = "connecting";
			try {
				const token = info.token
					? await unprotectSecret(info.token, info.protected ?? false)
					: null;
				this.#key = storedKey;
				this.#device = await deviceId();
				this.hasDeviceToken = token !== null;
				await this.#startEngine(info.serverUrl, token, {
					seq: info.seq ?? 0,
					priority: info.priority
				});

				// Im Browser ohne festes Gerätetoken: vor der Freigabe der App prüfen,
				// ob die Sitzung (Cookie) beim Server noch gültig ist.
				if (!isTauri() && !this.hasDeviceToken) {
					try {
						await this.accountInfo();
						this.state = "connected";
					} catch (e) {
						if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
							// Abgelaufene Sitzung ist kein Abmelden. Der Schlüssel bleibt
							// liegen, damit die nächste Passkey-Anmeldung die Daten wieder
							// öffnet, ohne nach den 24 Wörtern zu fragen - siehe
							// unlockWithStoredKey. Wer wirklich abmeldet, geht durch
							// `logout`, und dort wird alles gelöscht.
							//
							// Meldet sich danach ein ANDERES Konto an, räumt #persistLink
							// den fremden Bestand weg (foreignCopy).
							logWarn("Sitzung ist abgelaufen - Anmeldung nötig", e);
							this.#engine?.stop();
							this.#engine = null;
							this.#closeStream();
							this.#key = null;
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
				// Der häufigste Grund: die Datei stammt von einem anderen
				// Benutzerkonto. Dann ist die Verknüpfung hier nichts mehr wert.
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
				await updateDevice((info) => {
					// Erst hier prüfen, nicht vor dem Lesen: zwischen beidem kann das
					// Abmelden liegen. Eine Runde von vorher schriebe sonst den ganzen
					// gelesenen Stand zurück - Vault-Schlüssel eingeschlossen - oder
					// ihren Stand in die device.json des nächsten Kontos.
					if (!info || this.#engine !== engine) return null;
					return { ...info, seq: s.seq, priority: s.priority };
				});
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
				// Die Historie läuft im Hintergrund - dafür steht das Hinweisband
				// oben. Ein Modal davor sperrt die App zu, während daneben steht,
				// man könne schon arbeiten.
				if (p.background) {
					// Ab hier kommt nur noch Historie: der vorgezogene Teil steht, das
					// Modal darf weg - auch wenn der Durchgang noch weiterläuft.
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
		// Wer einen Monat öffnet, den der Backfill noch nicht hat, soll ihn sehen -
		// nicht eine leere Ansicht mit dem Hinweis, später wiederzukommen.
		app.setMonthFetcher((month) => this.ensureMonthSynced(month));
		await startTracking(this.#device);
		// Ab hier steht der Schreib-Haken. Erst jetzt darf die Reparatur der
		// eingebauten Zeilen laufen: sie hängt Einträge um, die bereits ein `rev`
		// tragen - ohne Haken würde rememberUnstamped() sie nicht aufsammeln und
		// die Umhängung erreichte den Server nie.
		await app.mergeDuplicateBuiltins();
		// Gleich mitholen, welche Passkeys den Schlüssel hergeben: im Klickpfad
		// darf diese Anfrage nicht liegen (siehe #passkeysWithWrap). Nur im
		// Browser - auf dem Rechner gibt es keine Passkeys.
		if (!isTauri()) void this.#passkeysWithWrap().catch(() => {});
		// Jede lokale Änderung stösst einen Abgleich an - gesammelt, nicht sofort.
		setChangeListener(() => this.syncSoon());
		this.#installNetworkListeners();
		this.#openStream();
	}

	/**
	 * Einmalig von vorne holen, wenn seit dem letzten Start eine Datensatzart
	 * dazugekommen ist. Siehe RESYNC_GENERATION.
	 *
	 * Der Merker wird VOR dem Abrufen gespeichert, zusammen mit dem
	 * zurückgesetzten Stand: bricht der Abruf ab, steht der Stand weiterhin auf 0
	 * und der nächste Versuch holt den Rest - ohne den Nachlauf ein zweites Mal
	 * auszulösen.
	 */
	async #rewindForNewKinds(state: SyncState): Promise<SyncState> {
		const info = await loadDevice();
		if (!info || info.resyncGeneration === RESYNC_GENERATION) return state;
		// Der vorgezogene Teil bleibt - sonst liefe der Abruf wieder ältestes
		// zuerst. Sein eigener Stand geht mit auf 0, er zeigte sonst hinter
		// Datensätze, die gerade erst nachkommen. Ein Gerät ohne vorgezogenen
		// Teil bekommt hier einen; `historyLocal` hält fest, dass seine Monate
		// schon auf der Platte liegen und die Sicherung erlaubt bleibt.
		const priority = state.priority
			? { ...state.priority, seq: 0 }
			: { seq: 0, months: [monthKey(Date.now()), prevMonthKey()], historyLocal: state.seq > 0 };
		const rewound: SyncState = { seq: 0, priority };
		// Stand 0 heisst: es gibt nichts nachzuholen - frisch verknüpft, oder noch
		// nie abgeglichen. Nur der Merker war fällig. Der Nachlauf-Vermerk darf
		// hier NICHT gesetzt werden: sonst gilt das Konto als schon benutzt, und
		// der lokale Bestand fände nie den Weg hinauf.
		if (state.seq === 0) {
			await updateDevice((cur) => cur && { ...cur, priority, resyncGeneration: RESYNC_GENERATION });
			return rewound;
		}
		await updateDevice(
			(cur) => cur && { ...cur, seq: 0, priority, resyncGeneration: RESYNC_GENERATION }
		);
		this.#rewound = true;
		logInfo("Hole den Serverstand einmalig von vorne", { reason: "neue Datensatzart" });
		return rewound;
	}

	// ---------- Abgleich ----------

	/** Wann zuletzt die Ansichten neu gelesen wurden - siehe `#reloadIsDue`. */
	#lastReload = 0;

	/**
	 * Steht ein Neulesen an?
	 *
	 * Ausserhalb des Backfills immer. Während er läuft, höchstens alle
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
	 * Die nächste Portion Historie anstossen.
	 *
	 * Mit eigenem Timer: `syncSoon` trägt den Wunsch des Nutzers, und den darf
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
	 * Der Schreib-Haken sieht nur, was während seiner Laufzeit geschrieben wird.
	 * Was vor dem Verknüpfen entstand oder mit einer verlorenen Outbox unterging,
	 * trägt keinen Stempel und fände sonst nie den Weg zum Server.
	 *
	 * Erst holen, dann vormerken: der frische Zeitstempel des ungestempelten
	 * Bestands gewänne sonst jeden Vergleich und überschriebe das Konto.
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
	 * Gehört der ungestempelte Bestand zu DIESEM Konto?
	 *
	 * Nach einem Kontowechsel auf dem Rechner liegen hier die Zeiten des vorigen
	 * Kontos. Sie bleiben - aber sie gehen nicht hoch. Ohne diese Frage hätte
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
	 * Modulzustand; der Schreib-Haken läuft dort nicht. Was es schreibt, trägt
	 * deshalb keinen Stempel und stünde ohne diesen Schritt nur lokal da.
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
		// Nur melden, wenn wirklich etwas läuft: liegt der Monat schon vor, käme
		// sonst für einen Wimpernschlag ein Spinner, den niemand deuten kann.
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
	 * Während der Backfill läuft, kennt die Platte nur die vorgezogenen Monate;
	 * die Auswahl zeigte sonst ausgerechnet die alten Monate nicht an, die man
	 * anklicken müsste, damit sie geholt werden.
	 *
	 * Der Server nennt nur Kennungen. Welcher Monat dahintersteckt, rechnet dieses
	 * Gerät selbst aus - die Kennung ist deterministisch, und der Server erfährt
	 * dabei nichts, was er nicht ohnehin hätte.
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
	 * Nur wo vorher auch "wird geladen" stand - der Backfill zählt in
	 * `result.pulled` mit und liesse den Abschluss sonst jede Runde aufblitzen.
	 */
	#finishBulkSync(): void {
		// Steht der Abschluss schon, läuft nur das Ende des Durchgangs hier ein
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

	/** Welcher Durchgang gerade seinen Nachlauf bekommt, und wer darauf wartet - siehe `syncNow`. */
	#handling: Promise<SyncOutcome | null> | null = null;
	#processing: Promise<void> | null = null;

	/**
	 * Abgleichen.
	 *
	 * `SyncEngine.sync()` dedupliziert bereits selbst und hängt per `#again`
	 * noch eine frische Runde an einen laufenden Durchgang, bevor er sich
	 * erfüllt - jeder Aufruf muss deshalb selbst dort ankommen, sonst bliebe ein
	 * gerade erst vorgemerkter Wunsch unberücksichtigt (siehe
	 * `syncWithFollowUp`, deren zweites `syncNow()` genau darauf baut). Nur der
	 * Nachlauf hier - Log, Reload, `notifyDataChanged` - darf nicht mehrfach
	 * laufen, wenn mehrere Aufrufer auf denselben Durchgang treffen: wer ihn
	 * schon in Arbeit hat, dessen Promise übernehmen die anderen unverändert -
	 * sonst gälte ihr eigenes `syncNow()` schon vor dem Reload als erledigt.
	 */
	async syncNow(): Promise<void> {
		const engine = this.#engine;
		if (!engine || this.state !== "connected") return;
		const round = engine.sync();
		if (round === this.#handling && this.#processing) {
			await this.#processing;
			return;
		}
		this.#handling = round;
		const processing = this.#afterSync(engine, round);
		this.#processing = processing;
		try {
			await processing;
		} finally {
			if (this.#handling === round) {
				this.#handling = null;
				this.#processing = null;
			}
		}
	}

	async #afterSync(engine: SyncEngine, round: Promise<SyncOutcome | null>): Promise<void> {
		this.phase = "running";
		try {
			const result = await round;
			// Kam etwas an, war dieses Gerät nie leer - es wusste es nur noch
			// nicht. Der Willkommensbildschirm hat sich damit erledigt, und zwar
			// bevor jemand ihn ausfüllt und dabei die echten Einstellungen
			// überschreibt. Vor `firstSyncDone`, sonst blitzt er dazwischen auf.
			if (result && result.pulled > 0 && app.showOnboarding) {
				app.dismissOnboarding();
			}
			this.backfilling = engine.backfilling;
			this.historyIncomplete = engine.historyIncomplete;
			this.phase = "idle";
			this.lastSync = Date.now();
			this.#retryStep = 0;
			if (result) {
				this.lostEdits += result.lostEdits;
				if (result.staleTimerSplits.length > 0) {
					this.staleTimerSplits = [...this.staleTimerSplits, ...result.staleTimerSplits];
				}
				if (result.pushed || result.pulled) {
					logInfo("Abgeglichen", result);
				}
				this.#finishBulkSync();
				// Die Historie kommt gedeckelt - fünf Seiten je Runde. Ohne Anstoss
				// läge die nächste Portion beim Herzschlag: alle fünf Minuten
				// tausend Sätze, und so lange bleiben Sicherung und Monatsauswahl
				// gesperrt.
				if (this.backfilling) this.#continueBackfill();
			} else {
				if (this.bulkSync?.phase === "pulling") this.bulkSync = null;
				toast.dismiss("sync-bulk");
			}
			// Der Bestand kann sich geändert haben - die Ansichten hängen daran.
			// Während die Historie läuft, kommen die Runden im Sekundentakt und
			// betreffen fast immer Monate, die niemand offen hat: dann reicht es,
			// gelegentlich nachzuziehen, statt bei jeder Portion alles von der
			// Platte zu lesen und /me zu fragen.
			if (result && (result.pulled > 0 || result.pushed > 0) && this.#reloadIsDue()) {
				await app.reload();
				// Erst NACH dem Reload gilt "abgeglichen" nach aussen - sonst sieht
				// z.B. die Berichts-Erinnerung kurz firstSyncDone=true neben noch
				// unaufgefrischten Einstellungen (reportSentMonths) und meldet einen
				// Monat als offen, der auf einem anderen Gerät längst erledigt wurde.
				this.firstSyncDone = true;
				void this.accountInfo().catch(() => {});
				void notifyDataChanged({ from: "sync" });
			} else {
				this.firstSyncDone = true;
			}
		} catch (e) {
			// Auch ein Durchgang, der am Ende scheitert, kann vorher schon Seiten
			// gepullt und auf die Platte geschrieben haben (Push vor Pull, mehrseitiger
			// Abruf) - am `app`-Zwischenspeicher geht das vorbei, der schreibt erst bei
			// reload() nach. Bliebe er stehen, überschriebe der nächste lokale Save
			// (z.B. Timer-Start) den frischen Diskstand mit dem alten - diffAndStamp
			// sieht dann einen frisch angekommenen Eintrag als "gelöscht" an und wirft
			// ihn samt Löschung in die Outbox.
			// `this.#engine` erneut prüfen, nicht nur beim Eintritt: eine Runde, die
			// noch lief, als unlink()/#forgetLocally() dazwischenkam, landet auch
			// hier - und ein Reload würde dann Dateien zurückschreiben (u.a.
			// #seedBuiltins), die das Abmelden gerade erst gelöscht hat.
			if (this.#engine && this.#reloadIsDue()) {
				try {
					await app.reload();
				} catch (reloadError) {
					// Der eigentliche Abgleichsfehler unten zählt - ein Lesefehler hier
					// darf ihn nicht verdecken.
					logWarn("Neuladen nach gescheitertem Abgleich fehlgeschlagen", reloadError);
				}
			}
			// Auch ein gescheiterter Versuch beantwortet die Frage "warten oder
			// anzeigen?": ohne Verbindung bleibt der Willkommensbildschirm sonst
			// für immer aus.
			this.firstSyncDone = true;
			this.bulkSync = null;
			toast.dismiss("sync-bulk");
			this.#onSyncError(e);
		}
	}

	#onSyncError(e: unknown): void {
		if (e instanceof ApiError && e.status === 401) {
			// Das Gerät wurde widerrufen oder das Token ist ungültig. Weiter zu
			// versuchen hat keinen Zweck und würde nur Anfragen erzeugen.
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

	/** Auf Änderungen anderer Geräte hören. */
	#openStream(): void {
		this.#closeStream();
		if (typeof EventSource === "undefined" || !this.#api) return;

		// In der Desktop-Anwendung geht kein EventSource: sie weist sich mit einem
		// Token aus, und EventSource kann keine Kopfzeilen setzen. Stattdessen eine
		// Anfrage, die der Server offen hält, bis sich etwas tut.
		if (isTauri()) {
			void this.#longPoll();
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
				// Den eigenen Weckruf überspringen: was dieses Gerät gerade
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
	 * Der Server hält jede Anfrage bis zu 25 Sekunden offen und antwortet, sobald
	 * ein anderes Gerät geschrieben hat. Damit ist die Desktop-Anwendung genauso
	 * schnell wie der Browser mit seinem Stream, ohne dass ein Token in eine
	 * Adresse wandern müsste.
	 */
	async #longPoll(): Promise<void> {
		const abort = new AbortController();
		this.#wait = abort;
		// Der langsame Takt bleibt als Netz darunter: fällt die Schleife aus,
		// läuft der Abgleich trotzdem weiter.
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
				// Nach einem Fehlschlag wachsend warten, sonst hämmert eine
				// abgerissene Verbindung gegen den Server.
				errorCount++;
				const pause = RETRY_MS[Math.min(errorCount - 1, RETRY_MS.length - 1)];
				logWarn("Weckruf-Schleife unterbrochen", e);
				await new Promise((r) => setTimeout(r, pause));
			}
		}
	}

	/** Der langsame Takt für alles, was keinen Kanal hat. */
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

	/** Ein neues Konto anlegen - von diesem Gerät aus, ohne Umweg über den Browser. */
	async createAccount(
		serverUrl: string,
		displayName: string,
		label: string,
		opts: { invite?: string; email?: string } = {}
	): Promise<string> {
		const url = serverUrl.replace(/\/+$/, "");
		const { registerFromDevice } = await import("./enroll");
		const r = await registerFromDevice(url, displayName, label, opts);
		await this.#persistLink(url, r.deviceToken, r.key, r.displayName, r.userId);
		return r.recoveryPhrase;
	}

	/** Ein Konto allein mit der Wiederherstellungs-Phrase zurückholen. */
	async recoverWithPhrase(serverUrl: string, phrase: string, label: string): Promise<void> {
		const url = serverUrl.replace(/\/+$/, "");
		const { recoverWithPhrase } = await import("./enroll");
		const r = await recoverWithPhrase(url, phrase, label);
		await this.#persistLink(url, r.deviceToken, r.key, r.displayName, r.userId);
	}

	// ---------- Koppeln: dieses Gerät ist neu ----------

	/** Schritt 1: einen Kopplungscode holen. Nur im Speicher - überdauert keinen Neustart. */
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

		// Der Code wird HIER gerechnet, aus dem eigenen öffentlichen Schlüssel -
		// er ist dessen Abdruck (siehe pairingCode). Der Server bekommt ihn nur
		// mitgeteilt und legt den Vorgang darunter ab.
		const code = await pairingCode(raw);

		// Der Code ist zum Vergleichen da und steht deshalb offen herum. Das
		// Abholen des Geräte-Tokens hängt an diesem Geheimnis, das dieses Gerät
		// behält - sonst genügte ein mitgelesener Code.
		const { secret: claimSecret, hash: claimHash } = await createClaimSecret();
		const answer = await api.pairStart(publicKey, label, code, claimHash);

		// Und was er zurückgibt, muss dasselbe sein. Ein Server, der einen anderen
		// Code herausgibt, brauchte ihn nur, um ihn auf den Bildschirm zu bekommen:
		// der Mensch trägt ihn drüben ein, drüben liegt dann ein Schlüssel, der
		// zu DIESEM Code passt - und das wäre nicht mehr unserer.
		if (answer.code !== code) {
			throw new Error("Der Server hat einen anderen Kopplungscode zurückgegeben.");
		}

		this.#pairing = { pair, code, url, claimSecret };
		return code;
	}

	/** Schritt 3: nachsehen, ob jemand bestätigt hat. */
	async checkPairing(): Promise<boolean> {
		if (!this.#pairing) return false;
		const { pair, code, url, claimSecret } = this.#pairing;
		const api = new Api({ baseUrl: url, fetchFn: platformFetch });
		const answer = await api.pairClaim(code, claimSecret);
		if (answer.pending) return false;

		// Das Paket öffnen - das kann nur dieses Gerät, mit seinem privaten
		// Schlüssel. Der Server hatte nie mehr als Chiffrat in der Hand.
		const key = await unwrapForDevice(answer.wrappedKey, pair.privateKey);

		await this.#persistLink(url, answer.deviceToken, key, "", answer.userId);
		this.#pairing = null;
		return true;
	}

	cancelPairing(): void {
		this.#pairing = null;
	}

	// ---------- Koppeln: dieses Gerät bestätigt ein anderes ----------

	/** Einen Code bestätigen. */
	async approvePairing(code: string): Promise<string> {
		// Zuerst der Schlüssel: er kann eine Bestätigung per Passkey verlangen,
		// und die soll vor dem Nachschlagen kommen, nicht mittendrin.
		const { api, key } = await this.#exportableKey();
		const typed = normalizePairingCode(code);
		const { publicKey, label } = await api.pairLookup(typed);

		// Wirft, wenn unter diesem Code ein anderer Schlüssel liegt als der, dessen
		// Abdruck er ist. Dann wird NICHTS verpackt: wer immer den Schlüssel
		// hinterlegt hat, bekäme sonst den Vault-Schlüssel.
		const raw = await checkedPairingKey(typed, publicKey).catch((e) => {
			logWarn("Kopplung abgebrochen: hinterlegter Schlüssel passt nicht zum Code");
			throw e;
		});

		const { wrapForDevice } = await import("../crypto/vault");
		const wrap = await wrapForDevice(key, raw);
		await api.pairApprove(typed, wrap);
		logInfo("Gerät gekoppelt", { label });
		void this.syncWithFollowUp();
		return label;
	}

	/** Nach Registrierung oder Anmeldung im Browser: die Verknüpfung übernehmen. */
	async linkWithSession(
		url: string,
		key: VaultKey,
		name: string,
		userId?: string
	): Promise<void> {
		await this.#persistLink(url.replace(/\/+$/, ""), null, key, name, userId);
	}

	/**
	 * Nach einer Anmeldung, die die Daten nicht öffnen konnte: den Schlüssel
	 * nehmen, der hier noch liegt.
	 *
	 * Läuft die Sitzung ab, bleibt der Schlüssel im Browser - abgemeldet wird
	 * damit nicht (siehe `logout`). Meldet sich danach dasselbe Konto per Passkey
	 * an, ist der Schlüssel hier schon der richtige, und niemand muss 24 Wörter
	 * abtippen.
	 *
	 * Gibt `false` zurück, wenn nichts liegt oder es ein anderes Konto ist.
	 */
	async unlockWithStoredKey(url: string, userId: string): Promise<boolean> {
		const info = await loadDevice();
		if (!info?.accountUserId) return false;
		// Ohne diesen Vergleich bekäme ein fremdes Konto den Schlüssel des vorigen.
		if (info.accountUserId !== userId) return false;
		try {
			const key = await this.#loadStoredKey(info);
			if (!key) return false;
			await this.#persistLink(url.replace(/\/+$/, ""), null, key, info.accountName ?? "", userId);
			return true;
		} catch (e) {
			logWarn("Hinterlegter Schlüssel ließ sich nicht öffnen", e);
			return false;
		}
	}

	// ---------- Verknüpfung ablegen und lösen ----------

	async #persistLink(
		url: string,
		token: string | null,
		key: VaultKey,
		name = "",
		userId?: string
	): Promise<void> {
		// VOR allem anderen: gleich raeumt ein Kontowechsel den lokalen Bestand weg,
		// und der erste Abgleich laesst bei einem Konflikt die neuere Fassung
		// gewinnen - auch gegen eine eigene, noch nicht hochgeladene Aenderung.
		// Danach fuehrt kein Weg zurueck, also hier die Sicherung.
		//
		// Dynamisch geladen: `backup.ts` haengt seinerseits an diesem Modul.
		await import("../report/backup")
			.then((m) => m.snapshotBeforePairing())
			.catch(() => null);

		this.#key = key;
		// Was hier liegt, gehört dem vorigen Konto.
		this.#forgetWrapIds();
		this.#device = await deviceId();
		// Im Browser gibt es kein Geräte-Token: dort weist das Sitzungs-Cookie aus.
		const protectedToken = token ? await protectSecret(token) : null;

		// Wie der Vault-Schlüssel liegen bleibt, damit die Anwendung nach einem
		// Neuladen nicht wieder nach der Anmeldung fragen muss - je Plattform anders:
		// auf dem Rechner schützt das Betriebssystem (protectSecret), im Browser
		// gibt es dafür keinen echten Schutz - dort liegt seit diesem Umbau
		// stattdessen eine nicht-exportierbare Kopie in einer eigenen IndexedDB
		// (keyStore.ts).
		let vaultKeyData: string | undefined;
		let vaultKeyProtected = true;
		if (!usingBrowserStorage()) {
			const raw = toBase64(new Uint8Array(await exportVaultKey(key)));
			const wrapped = await protectSecret(raw);
			vaultKeyData = wrapped.data;
			vaultKeyProtected = wrapped.protected;
		} else {
			// Eine bereits nicht-exportierbare Kopie gibt ihre Bytes nie wieder her
			// (`key` ist dann eine solche, z.B. aus `unlockWithStoredKey`) - die
			// abgelegte ist dieselbe und passt noch, nichts zu tun.
			if (!isExportable(key)) {
				setLocalEncryptionKey(key);
			} else {
				const raw = await exportVaultKey(key);
				try {
					const copy = await importVaultKey(raw, false);
					await saveLocalVaultKey(copy);
					setLocalEncryptionKey(copy);
				} catch (e) {
					// Ablegen fehlgeschlagen, obwohl ein neuer Schlüssel vorliegt - eine
					// jetzt veraltete Kopie in der Ablage wäre schlimmer als keine: sie
					// sähe beim nächsten Start wie der richtige Schlüssel aus und
					// liesse echte, mit dem NEUEN Schlüssel verschlüsselte Dateien
					// falsch entschlüsseln. Lieber nichts liegen haben - das führt beim
					// nächsten Start zu preloadLocalEncryptionKey()s Fehler statt zu
					// stillem Datenverlust.
					logWarn("Vault-Schlüssel ließ sich nicht lokal ablegen", e);
					await clearLocalVaultKey().catch(() => {});
					setLocalEncryptionKey(key);
				}
			}
		}

		// Der erste Abgleich zieht vor, was der Mensch sofort sieht. Ohne das käme
		// der laufende Monat zuletzt: der Server liefert nach Stand aufsteigend,
		// also die ältesten Einträge zuerst.
		const startState: SyncState = {
			seq: 0,
			priority: { seq: 0, months: [monthKey(Date.now()), prevMonthKey()] }
		};

		// Wessen Konto ist das? Zwei Konten haben verschiedene Vault-Schlüssel,
		// also verschiedene Nachweise.
		const fingerprint = await vaultProof(key);

		let keptPasskeyId: string | undefined;
		// Lesen, entscheiden und schreiben in einem Zug: parallel dazu schreibt der
		// Abgleich seinen Stand in dieselbe Datei, und ein verlorener Stand hier
		// hiesse Kontodaten von zwei Konten nebeneinander.
		await updateDevice(async (stored) => {
			const info = stored ?? { id: this.#device };
			const switched = Boolean(
				info.accountFingerprint && info.accountFingerprint !== fingerprint
			);

			// Im Browser gibt es keinen Bestand ohne Konto - man kommt ohne Anmeldung
			// gar nicht hinein. Was hier liegt, ist die Kopie IRGENDEINES Kontos. Lässt
			// sich nicht beweisen, dass es dieses ist, kommt es weg; der Server hat es.
			// Auf dem Rechner sind die Zeiten die Sache des Menschen: sie bleiben, gehen
			// aber nicht hoch (siehe dataOwner).
			const foreignCopy = !isTauri() && info.accountFingerprint !== fingerprint;
			if (foreignCopy) {
				await clearAccountData();
				app.clearLocalData();
				logInfo("Kontowechsel / Neuverknüpfung: lokale Kopie entfernt");
			}

			// Die Merkliste gehört IMMER dem vorigen Konto - auf beiden Plattformen.
			// Ohne diese Zeile lädt sie der nächste Abgleich ins neue Konto: `#pushAll`
			// liest die Outbox, nicht den Stempel.
			if (switched || foreignCopy) await clearOutbox();

			// Wem der Bestand gehört: nach einem Wechsel weiterhin dem alten Konto
			// (dann bleibt er hier liegen), sonst diesem. Wer noch nie ein Konto hatte,
			// dessen Bestand ist der eigene und gehört hoch.
			const dataOwner = switched && isTauri() ? info.dataOwner : fingerprint;
			// Beim Wechsel wird NICHTS gerätegebundenes vom vorigen Konto geerbt -
			// weder die Kontokennung (an der `unlockWithStoredKey` hängt: eine
			// stehengebliebene Kennung gäbe den neuen Schlüssel an das alte Konto)
			// noch der Passkey (der gehört dem vorigen Konto).
			const keepsPreviousAccount = !switched && !foreignCopy;
			keptPasskeyId = keepsPreviousAccount ? info.passkeyId : undefined;

			return {
				...info,
				id: this.#device,
				serverUrl: url,
				token: protectedToken?.data,
				vaultKey: vaultKeyData,
				protected: vaultKeyProtected && (protectedToken?.protected ?? true),
				accountName: name || info.accountName,
				accountUserId: userId ?? (keepsPreviousAccount ? info.accountUserId : undefined),
				passkeyId: keptPasskeyId,
				accountFingerprint: fingerprint,
				dataOwner,
				seq: 0,
				priority: startState.priority
			};
		});
		this.name = name || this.name;
		this.passkeyId = keptPasskeyId ?? null;

		this.serverUrl = url;
		this.secretsProtected = vaultKeyProtected;
		this.hasDeviceToken = token !== null;
		this.state = "connected";
		await this.#startEngine(url, token, startState);
		void this.syncWithFollowUp();
	}

	/** Nachsehen, was am Konto hängt - vor allem, wie viele Geräte und die Verwalterrolle. */
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
				await updateDevice((info) => info && { ...info, accountName: res.displayName });
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
	// Nur im Browser: ein Passkey hängt an der Domain, und die Desktop-Anwendung
	// hat keine. Dort ist der Weg zu einem zweiten Gerät die Kopplung.

	/** Die Passkeys des Kontos - aus `accountInfo`, das sie ohnehin mitbringt. */
	async passkeys(): Promise<Passkey[]> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return (await this.#api.me()).passkeys;
	}

	/**
	 * Merken, welcher Passkey zu diesem Browser gehört.
	 *
	 * Nach einer Anmeldung und nach dem Anlegen. Ohne den Vermerk ist von der
	 * Kontoliste aus nicht zu sehen, welcher Eintrag der eigene ist.
	 */
	async rememberPasskey(id: string): Promise<void> {
		this.passkeyId = id;
		await updateDevice((info) => (info && info.passkeyId !== id ? { ...info, passkeyId: id } : null));
	}

	/** Einen weiteren Passkey anlegen. */
	async addPasskey(label: string): Promise<{ prfAvailable: boolean }> {
		const { api, key } = await this.#exportableKey();
		const { addPasskey } = await import("./enroll");
		const result = await addPasskey(api, key, label);
		this.#forgetWrapIds();
		await this.rememberPasskey(result.id);
		return { prfAvailable: result.prfAvailable };
	}

	/**
	 * Einen vorhandenen Passkey nachträglich die Daten öffnen lassen - ohne die
	 * 24 Wörter.
	 *
	 * Liegt der PRF-Wert schon vor (er fällt bei jeder Anmeldung an), kostet das
	 * keine zweite Abfrage.
	 *
	 * Eine NEUE Verpackung braucht die Rohbytes des Schlüssels, und die gibt der
	 * PRF-Wert des Aufrufers nicht her - er ist das Ziel der Verpackung, nicht
	 * ihre Quelle. Nach einem Neuladen kommen sie deshalb aus einem anderen
	 * Passkey, der schon eine Verpackung hat (siehe `#exportableKey`); gibt es
	 * keinen, wird mit einem Hinweis auf die 24 Wörter geworfen, statt eine
	 * Bestätigung für nichts zu verlangen.
	 */
	async repairPasskeyWrap(
		credentialId?: string,
		prf?: Uint8Array | null
	): Promise<{ ok: true } | { ok: false; reason: PrfFailure }> {
		const { api, key } = await this.#exportableKey();
		const { ensurePasskeyWrap } = await import("./enroll");
		const result = await ensurePasskeyWrap(api, key, credentialId, prf);
		this.#forgetWrapIds();
		// Ohne Kennung nimmt der Browser den Passkey, den er anbietet - erst die
		// Antwort sagt, welcher das war.
		if (result.ok) await this.rememberPasskey(result.credentialId);
		return result;
	}

	/**
	 * Die Passkeys, zu denen eine Verpackung liegt - im Voraus geholt.
	 *
	 * `#exportableKey` braucht die Liste, um nur nach Passkeys zu fragen, die den
	 * Schlüssel wirklich hergeben. Sie darf NICHT im Klickpfad geholt werden:
	 * WebAuthn will unmittelbar auf die Berührung folgen, und eine Anfrage
	 * dazwischen kostet auf schmaler Leitung genau die Berechtigung, die der
	 * Dialog braucht (siehe `enroll.ts`, "Die Aufgabe im Voraus holen").
	 */
	#wrapIds: Promise<string[]> | null = null;

	#passkeysWithWrap(): Promise<string[]> {
		if (this.#wrapIds) return this.#wrapIds;
		const api = this.#api;
		if (!api) return Promise.resolve([]);
		const task = api
			.wraps()
			.then(({ wraps }) =>
				wraps
					.filter((w) => w.kind === "passkey" && w.credentialId)
					.map((w) => w.credentialId as string)
			);
		this.#wrapIds = task;
		// Ein Fehlschlag darf sich nicht einbrennen - der nächste Versuch fragt wieder.
		void task.catch(() => {
			if (this.#wrapIds === task) this.#wrapIds = null;
		});
		return task;
	}

	/** Nach jeder Änderung an den Verpackungen: die Liste neu holen lassen. */
	#forgetWrapIds(): void {
		this.#wrapIds = null;
	}

	/**
	 * Ein Schlüssel, der seine Bytes noch hergibt.
	 *
	 * Nach einem Neuladen der Seite liegt hier die Kopie aus der eigenen Ablage -
	 * sie kann alles ausser das eine: einen weiteren Passkey oder ein weiteres
	 * Gerät anlernen. Dafür liefert ein Passkey mit Verpackung den Schlüssel
	 * erneut - bevorzugt der dieses Browsers. Dass es wirklich derselbe Vault ist,
	 * sagt der Nachweis - er lässt sich aus beiden rechnen, ohne dass einer von
	 * beiden Bytes herausgeben muss.
	 */
	async #exportableKey(): Promise<{ api: Api; key: VaultKey }> {
		if (!this.#key) throw new Error("Das Konto ist nicht entsperrt");
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		const api = this.#api;
		if (isExportable(this.#key)) return { api, key: this.#key };
		const { reunlockWithPasskey } = await import("./enroll");
		const key = await reunlockWithPasskey(api, {
			preferred: this.passkeyId ?? undefined,
			usableIds: await this.#passkeysWithWrap()
		});
		if ((await vaultProof(key)) !== (await vaultProof(this.#key))) {
			throw new Error("Der bestätigte Passkey gehört zu einem anderen Konto.");
		}
		this.#key = key;
		return { api, key };
	}

	/** Die Kennung dieses Geräts - damit die Liste das eigene erkennt. */
	get thisDeviceId(): string {
		return this.#device;
	}

	/** Ein anderes Gerät vom Konto trennen. Es kommt danach nicht mehr hinein. */
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
		// Sonst haelt #exportableKey() den geloeschten Passkey noch fuer nutzbar
		// und schlaegt den WebAuthn-Dialog fuer genau den vor.
		this.#forgetWrapIds();
	}

	// ---------- Verwaltung ----------
	//
	// Nur für Verwalter, und der Server entscheidet das - nicht dieses Modul.
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

	// ---------- Team-Modus ----------

	async listTeams(): Promise<TeamInfo[]> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return (await this.#api.listTeams()).teams;
	}

	async createTeam(name: string): Promise<TeamInfo> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return this.#api.createTeam(name);
	}

	async deleteTeam(teamId: string): Promise<void> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		await this.#api.deleteTeam(teamId);
	}

	async getTeamInvite(teamId: string): Promise<TeamInvite | null> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return (await this.#api.getTeamInvite(teamId)).invite;
	}

	async rotateTeamInvite(teamId: string): Promise<TeamInvite> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return this.#api.rotateTeamInvite(teamId);
	}

	async listTeamMembers(teamId: string): Promise<TeamMemberInfo[]> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return (await this.#api.listTeamMembers(teamId)).members;
	}

	async revokeTeamMember(teamId: string, memberId: string): Promise<void> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		await this.#api.revokeTeamMember(teamId, memberId);
	}

	async listTeamAdmins(teamId: string): Promise<TeamAdminInfo[]> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return (await this.#api.listTeamAdmins(teamId)).admins;
	}

	async removeTeamAdmin(teamId: string, userId: string): Promise<void> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		await this.#api.removeTeamAdmin(teamId, userId);
	}

	async getAdminInvite(teamId: string): Promise<TeamInvite | null> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return (await this.#api.getAdminInvite(teamId)).invite;
	}

	async rotateAdminInvite(teamId: string): Promise<TeamInvite> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return this.#api.rotateAdminInvite(teamId);
	}

	async joinTeamAsAdmin(code: string): Promise<TeamInfo> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return this.#api.joinTeamAsAdmin(code);
	}

	async transferTeamOwnership(teamId: string, newOwnerUserId: string): Promise<void> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		await this.#api.transferTeamOwnership(teamId, newOwnerUserId);
	}

	async listTeamActivities(teamId: string): Promise<TeamActivity[]> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return (await this.#api.listTeamActivities(teamId)).activities;
	}

	async setTeamActivities(
		teamId: string,
		activities: TeamActivityInput[],
		expectedVersion?: number
	): Promise<TeamActivity[]> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return (await this.#api.setTeamActivities(teamId, activities, expectedVersion)).activities;
	}

	async listTeamReports(teamId: string, month: string): Promise<TeamReportStatus[]> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return (await this.#api.listTeamReports(teamId, month)).reports;
	}

	async markTeamReportSent(teamId: string, memberId: string, month: string): Promise<void> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		await this.#api.markTeamReportSent(teamId, memberId, month);
	}

	async clearTeamReportStatus(
		teamId: string,
		memberId: string,
		month: string,
		expectedSubmittedAt: number
	): Promise<void> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		await this.#api.clearTeamReportStatus(teamId, memberId, month, expectedSubmittedAt);
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
	 * Der Server, an den die Tagesmeldung ginge - leer heisst: es gibt keinen.
	 *
	 * Ohne verknüpftes Konto meldet die Desktop-Anwendung an den Server, der
	 * beim Bauen eingetragen wurde; ausweisen kann sie sich dort nur mit dem
	 * Schlüssel aus dem Build, ohne ihn käme sie gar nicht durch. Im Browser
	 * gibt es diesen Weg nicht: dort zählt, wer angemeldet ist.
	 */
	get usagePingServer(): string {
		if (this.serverUrl) return this.serverUrl;
		return isTauri() && TELEMETRY_KEY ? DEFAULT_SERVER : "";
	}

	/**
	 * Dem Server anonym melden, dass die Anwendung heute lief. Wirft nie.
	 *
	 * Mit Konto über `#api`: die Meldung weist sich dann genauso aus wie jeder
	 * andere Serveraufruf - mit dem Gerätetoken, sonst mit dem Cookie. Ohne
	 * Konto gibt es kein `#api`, und der Weg geht über `usagePingServer`.
	 */
	async sendUsagePing(): Promise<PingResult> {
		const target = this.usagePingServer;
		if (!target) return "retry";
		const api = this.#api ?? new Api({ baseUrl: target, fetchFn: platformFetch });
		try {
			await api.telemetry({
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
	 * Abmelden: die Sitzung beim Server beenden und die Verknüpfung hier vergessen.
	 *
	 * Die erfassten Zeiten bleiben liegen - abmelden ist kein Löschen. Der Passkey
	 * bleibt am Konto, die nächste Anmeldung geht damit wieder auf.
	 */
	async logout(): Promise<void> {
		try {
			await this.#api?.logout();
		} catch (e) {
			// Eine abgelaufene Sitzung lässt sich nicht noch einmal beenden. Lokal
			// vergessen muss trotzdem gehen, sonst sitzt jemand an einem fremden
			// Rechner fest, an dem er sich gerade abmelden wollte.
			logWarn("Abmelden beim Server fehlgeschlagen", e);
		}
		await this.unlink();
	}

	/** Die Verknüpfung lösen. */
	async unlink(opts: UnlinkOptions = {}): Promise<DeleteSummary | null> {
		let summary: DeleteSummary | null = null;

		if (opts.deleteRemote || opts.revokeSelf) {
			if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
			// Zuerst der Server, solange Zugang und Token noch stehen. Danach ist
			// beides weg und der Vorgang liesse sich nicht mehr nachholen.
			if (opts.deleteRemote) {
				summary = await this.#api.deleteAccount(await this.#confirmWithPasskey());
			} else {
				await this.#api.revokeDevice();
			}
		}

		await this.#forgetLocally();
		// Erst nachdem der Zugang wirklich weg ist: die Stempel abstreifen. Vorher
		// wäre ein Abbruch mittendrin der schlechteste aller Zustände - Daten
		// ohne Fassungsnummern, aber ein Konto, das sie noch erwartet.
		const unlinked = await detachLocalData();
		// Im Browser war der Bestand nur eine Kopie des Servers. Bliebe er liegen,
		// sieht der nächste Mensch an diesem Rechner die Zeiten des vorigen.
		//
		// Der Schlüssel geht erst HIER, nicht schon in #forgetLocally: detachLocalData
		// (oben) liest die Einträge noch einmal - ohne Schlüssel wäre das ein
		// Fehlschlag, keine Entschlüsselung.
		// VOR dem Aufraeumen: im Browser raeumt `#wipeLocalData` auch die
		// Protokolle weg. Andersherum schrieb diese Zeile die Datei gleich wieder
		// an - und genau sie blieb dann als einziger Rest liegen.
		logInfo("Verknüpfung gelöst", { ...opts, ...unlinked });
		if (!isTauri()) {
			await this.#wipeLocalData();
		}
		return summary;
	}

	/** Den Menschen bestätigen lassen - mit dem Passkey, nicht mit einem Haken. */
	async #confirmWithPasskey(): Promise<{ challengeId: string; response: unknown } | undefined> {
		if (isTauri()) return undefined;
		const { startAuthentication } = await import("@simplewebauthn/browser");
		const { challengeId, options } = await this.#api!.confirmStart();
		const response = await startAuthentication({
			optionsJSON: options as Parameters<typeof startAuthentication>[0]["optionsJSON"]
		});
		return { challengeId, response };
	}

	/**
	 * Der Weg zurück, wenn der Start gar nicht durchkommt.
	 *
	 * `unlink()` setzt eine laufende Verknüpfung voraus - es meldet sich beim
	 * Server ab und rechnet den lokalen Bestand ab. Bleibt `app.init()` schon
	 * vorher stehen (etwa, weil sich der Schlüssel dieses Browsers nicht mehr
	 * öffnen lässt), ist davon nichts erreichbar, und ohne diesen Weg bliebe
	 * nur, die Website-Daten von Hand zu löschen.
	 *
	 * Nur im Browser aufrufen: dort ist der lokale Bestand die Kopie eines
	 * Kontos und liegt nach dem nächsten Anmelden wieder da. Auf dem Rechner
	 * gehören die Zeiten dem Menschen - sie sind Dateien, und die bleiben.
	 */
	async forgetLink(): Promise<void> {
		await this.#forgetLocally();
		await this.#wipeLocalData();
	}

	/** Alles abstellen und die Kontodaten dieses Geräts vergessen. */
	async #forgetLocally(): Promise<void> {
		// Zuerst die Engine, und zwar ohne ein einziges await davor: eine laufende
		// Runde antwortet noch, wenn hier längst aufgeräumt ist. Ohne stop()
		// spielt sie die Daten des alten Kontos wieder ein, und ihr `saveState`
		// trägt den Vault-Schlüssel in die gerade geleerte device.json zurück.
		this.#engine?.stop();
		this.#engine = null;

		// Dann der Schlüssel - vor allem, was fremden Code ruft (Timer, Haken,
		// Oberfläche). Wirft dort etwas, läge er sonst weiter im Browser, und
		// mit ihm die Adresse des Servers.
		// Nur die Kontodaten löschen, nicht die Gerätekennung: die soll
		// dieselbe bleiben, falls jemand erneut koppelt.
		await updateDevice((info) => info && { id: info.id });

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
		this.#forgetWrapIds();
		// Den Prefetch-Puffer leeren: er gehört dem abgemeldeten Konto. Sonst
		// könnte ein schneller Re-Login in denselben 30-Sekunden-Fenstern Name,
		// E-Mail und Geräte-Labels des vorigen Nutzers sehen.
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

export const account = new AccountState();
export { createVaultKey };
