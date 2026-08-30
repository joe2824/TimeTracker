// Das Konto, wie die Oberflaeche es sieht.
import { app } from "../app.svelte";
import { logError, logInfo, logWarn } from "../log";
import {
	clearAccountData,
	clearOutbox,
	loadDevice,
	loadEntries,
	saveDevice,
	saveEntries
} from "../store";
import { loadActivities, saveActivities, loadSettings, saveSettings, listEntryMonths } from "../store";
import { deviceId } from "./device";
import {
	startTracking,
	stopTracking,
	pendingChanges,
	setChangeListener,
	merkeUngestempeltes
} from "./outbox";
import { Api, ApiError, type AccountInfo, type DeleteSummary, type Invite, type Passkey } from "./api";
import { detachLocalData } from "./detach";
import { SyncEngine } from "./engine";
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
	createClaimSecret,
	toBase64,
	unwrapForDevice,
	vaultProof,
	type KeyWrap
} from "../crypto/vault";
import { protectSecret, unprotectSecret } from "../platform/secrets";
import { isTauri } from "../platform/env";
import { platformFetch } from "../platform/http";
import { notifyDataChanged } from "../platform/windows";

export type LinkState = "aus" | "verbindet" | "verbunden" | "fehler";

/** Wie weit das Entkoppeln gehen soll - siehe `AccountState.unlink`. */
export interface UnlinkOptions {
	/** Den Zugang dieses Geraets auch beim Server beenden. */
	revokeSelf?: boolean;
	/** Das ganze Konto aufloesen, samt aller Serverdaten. */
	deleteRemote?: boolean;
}

/** Wie es dem Abgleich gerade geht - genau das, was die Oberflaeche zeigt. */
export type SyncPhase = "ruht" | "laeuft" | "offline" | "fehler";

/**
 * Wie lange nach einer Aenderung gewartet wird, bevor hochgeladen wird.
 *
 * Kurz genug, dass ein Timer-Start sofort drueben ist; lang genug, dass Tippen
 * in einer Notiz nicht jede Taste einzeln hochlaedt.
 */
const DEBOUNCE_MS = 400;

/** Abstand zwischen zwei Verbindungsversuchen, wachsend. */
const RETRY_MS = [5_000, 15_000, 60_000, 300_000];

/** Der langsame Takt, wo es keinen Weckruf-Kanal gibt. */
const HEARTBEAT_MS = 5 * 60 * 1000;

class AccountState {
	state = $state<LinkState>("aus");
	phase = $state<SyncPhase>("ruht");
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
	pairCodeFromLink = $state<string>("");

	#api: Api | null = null;
	#engine: SyncEngine | null = null;
	#key: CryptoKey | null = null;
	#stream: EventSource | null = null;
	#debounce: ReturnType<typeof setTimeout> | null = null;
	#retry: ReturnType<typeof setTimeout> | null = null;
	#retryStep = 0;
	#device = "";
	#heartbeat: ReturnType<typeof setInterval> | null = null;
	/** Laeuft eine Weckruf-Schleife? Der Abbruch beendet auch die offene Anfrage. */
	#warten: AbortController | null = null;

	get linked(): boolean {
		return this.state === "verbunden";
	}

	get pending(): number {
		return this.linked ? pendingChanges().length : 0;
	}

	// ---------- Start ----------

	/** Beim Programmstart: falls ein Konto verknuepft ist, alles hochfahren. */
	async init(): Promise<void> {
		const info = await loadDevice();
		// Ohne Adresse oder Schluessel gibt es nichts zu verbinden. Das Token darf
		// fehlen: im Browser weist das Sitzungs-Cookie aus.
		if (!info?.serverUrl || !info.vaultKey) return;

		this.serverUrl = info.serverUrl;
		this.name = info.accountName ?? "";
		this.secretsProtected = info.protected ?? false;
		this.state = "verbindet";
		try {
			const token = info.token
				? await unprotectSecret(info.token, info.protected ?? false)
				: null;
			const rohschluessel = await unprotectSecret(info.vaultKey, info.protected ?? false);
			this.#key = await importVaultKey(fromBase64(rohschluessel).buffer as ArrayBuffer);
			this.#device = await deviceId();
			this.hasDeviceToken = token !== null;
			await this.#startEngine(info.serverUrl, token, info.seq ?? 0);
			this.state = "verbunden";
			logInfo("Konto verknüpft", { server: info.serverUrl });
			// Nebenher: die Rolle steht erst fest, wenn der Server geantwortet hat.
			// Ein Fehlschlag darf den Start nicht aufhalten - dann fehlt eben der
			// Verwaltungsbereich, bis der naechste Abgleich laeuft.
			void this.accountInfo().catch(() => {});
			void this.abgleichMitNachlese();
		} catch (e) {
			// Der haeufigste Grund: die Datei stammt von einem anderen
			// Benutzerkonto. Dann ist die Verknuepfung hier nichts mehr wert.
			this.state = "fehler";
			this.message = e instanceof Error ? e.message : "Verknüpfung nicht lesbar";
			logError("Verknüpfung konnte nicht geöffnet werden", e);
		}
	}

	async #startEngine(url: string, token: string | null, seq: number): Promise<void> {
		this.#api = new Api({ baseUrl: url, token, fetchFn: platformFetch });
		this.#engine = new SyncEngine({
			api: this.#api,
			key: this.#key!,
			deviceId: this.#device,
			state: { seq },
			saveState: async (s) => {
				const info = await loadDevice();
				if (info) await saveDevice({ ...info, seq: s.seq });
			},
			store: {
				entriesOfMonth: loadEntries,
				saveEntries,
				activities: loadActivities,
				saveActivities,
				settings: loadSettings,
				saveSettings
			}
		});
		this.#engine.setMonthLister(listEntryMonths);
		await startTracking(this.#device);
		// Jede lokale Aenderung stoesst einen Abgleich an - gesammelt, nicht sofort.
		setChangeListener(() => this.syncSoon());
		this.#openStream();
	}

	// ---------- Abgleich ----------

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
	async abgleichMitNachlese(): Promise<void> {
		const vorSeq = (await loadDevice())?.seq ?? 0;
		await this.syncNow();
		if (await this.#bestandIstUnserer()) {
			await merkeUngestempeltes(vorSeq === 0);
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
	async #bestandIstUnserer(): Promise<boolean> {
		const info = await loadDevice();
		if (!info?.bestandGehoertZu || !info.kontoKennung) return true;
		return info.bestandGehoertZu === info.kontoKennung;
	}

	/**
	 * Ein anderes Fenster hat geschrieben - nachsehen und hochladen.
	 *
	 * Das Tray-Fenster hat einen eigenen Webview und damit einen eigenen
	 * Modulzustand; der Schreib-Haken laeuft dort nicht. Was es schreibt, traegt
	 * deshalb keinen Stempel und stuende ohne diesen Schritt nur lokal da.
	 */
	async nachlese(): Promise<void> {
		if (!this.linked) return;
		if (!(await this.#bestandIstUnserer())) return;
		await merkeUngestempeltes();
		this.syncSoon(0);
	}

	async syncNow(): Promise<void> {
		if (!this.#engine || this.state !== "verbunden") return;
		this.phase = "laeuft";
		try {
			const ergebnis = await this.#engine.sync();
			this.phase = "ruht";
			this.lastSync = Date.now();
			this.#retryStep = 0;
			if (ergebnis) {
				this.lostEdits += ergebnis.lostEdits;
				if (ergebnis.pushed || ergebnis.pulled) {
					logInfo("Abgeglichen", ergebnis);
				}
			}
			// Der Bestand kann sich geaendert haben - die Ansichten haengen daran.
			await app.reload();
			void this.accountInfo().catch(() => {});
			// Und das Tray-Fenster liest dieselben Dateien, bekommt davon aber
			// nichts mit: es haelt seinen eigenen Zustand.
			if (ergebnis && ergebnis.pulled > 0) void notifyDataChanged();
			// Kam beim ersten Abgleich etwas an, war dieses Geraet nie leer - es
			// wusste es nur noch nicht. Der Willkommensbildschirm hat sich damit
			// erledigt, und zwar bevor jemand ihn ausfuellt und dabei die echten
			// Einstellungen ueberschreibt.
			if (ergebnis && ergebnis.pulled > 0 && app.showOnboarding) {
				app.dismissOnboarding();
			}
		} catch (e) {
			this.#onSyncError(e);
		}
	}

	#onSyncError(e: unknown): void {
		if (e instanceof ApiError && e.status === 401) {
			// Das Geraet wurde widerrufen oder das Token ist ungueltig. Weiter zu
			// versuchen hat keinen Zweck und wuerde nur Anfragen erzeugen.
			this.state = "fehler";
			this.phase = "fehler";
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
		this.phase = "fehler";
		this.message = e instanceof Error ? e.message : "Abgleich fehlgeschlagen";
		logError("Abgleich fehlgeschlagen", e);
		this.#scheduleRetry();
	}

	#scheduleRetry(): void {
		if (this.#retry) clearTimeout(this.#retry);
		const wartezeit = RETRY_MS[Math.min(this.#retryStep, RETRY_MS.length - 1)];
		this.#retryStep++;
		this.#retry = setTimeout(() => void this.syncNow(), wartezeit);
	}

	// ---------- Weckruf-Kanal ----------

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
			this.#stream.addEventListener("change", (ev) => {
				const daten = JSON.parse((ev as MessageEvent).data ?? "{}");
				// Den eigenen Weckruf ueberspringen: was dieses Geraet gerade
				// hochgeladen hat, muss es nicht wieder herunterladen.
				if (daten.deviceId === this.#device) return;
				this.syncSoon(300);
			});
			this.#stream.onerror = () => {
				// EventSource verbindet von selbst neu. Nichts tun ist hier richtig -
				// ein eigener Versuch liefe dagegen.
				if (this.phase !== "laeuft") this.phase = "offline";
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
		const abbruch = new AbortController();
		this.#warten = abbruch;
		// Der langsame Takt bleibt als Netz darunter: faellt die Schleife aus,
		// laeuft der Abgleich trotzdem weiter.
		this.#startHeartbeat();

		let fehler = 0;
		while (this.#warten === abbruch && this.state === "verbunden") {
			try {
				const stand = (await loadDevice())?.seq ?? 0;
				const antwort = await this.#api!.waitForChange(stand, abbruch.signal);
				if (this.#warten !== abbruch) return;
				fehler = 0;
				if (antwort.changed) this.syncSoon(100);
			} catch (e) {
				if (abbruch.signal.aborted) return;
				// Nach einem Fehlschlag wachsend warten, sonst haemmert eine
				// abgerissene Verbindung gegen den Server.
				fehler++;
				const pause = RETRY_MS[Math.min(fehler - 1, RETRY_MS.length - 1)];
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

	/** Das Fenster kommt in den Vordergrund. */
	onVisible(): void {
		if (this.state === "verbunden") this.syncSoon(0);
	}

	#closeStream(): void {
		this.#stream?.close();
		this.#stream = null;
		this.#warten?.abort();
		this.#warten = null;
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
		const roh = await exportPairingPublicKey(pair);
		const publicKey = toBase64(roh);

		// Der Code wird HIER gerechnet, aus dem eigenen oeffentlichen Schluessel -
		// er ist dessen Abdruck (siehe pairingCode). Der Server bekommt ihn nur
		// mitgeteilt und legt den Vorgang darunter ab.
		const code = await pairingCode(roh);

		// Der Code ist zum Vergleichen da und steht deshalb offen herum. Das
		// Abholen des Geraete-Tokens haengt an diesem Geheimnis, das dieses Geraet
		// behaelt - sonst genuegte ein mitgelesener Code.
		const { secret: claimSecret, hash: claimHash } = await createClaimSecret();
		const antwort = await api.pairStart(publicKey, label, code, claimHash);

		// Und was er zurueckgibt, muss dasselbe sein. Ein Server, der einen anderen
		// Code herausgibt, brauchte ihn nur, um ihn auf den Bildschirm zu bekommen:
		// der Mensch traegt ihn drueben ein, drueben liegt dann ein Schluessel, der
		// zu DIESEM Code passt - und das waere nicht mehr unserer.
		if (antwort.code !== code) {
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
		const antwort = await api.pairClaim(code, claimSecret);
		if (antwort.pending) return false;

		// Das Paket oeffnen - das kann nur dieses Geraet, mit seinem privaten
		// Schluessel. Der Server hatte nie mehr als Chiffrat in der Hand.
		const wrap = JSON.parse(antwort.wrappedKey) as {
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

		await this.#persistLink(url, antwort.deviceToken, key);
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
		const getippt = normalizePairingCode(code);
		const { publicKey, label } = await this.#api.pairLookup(getippt);

		// Wirft, wenn unter diesem Code ein anderer Schluessel liegt als der, dessen
		// Abdruck er ist. Dann wird NICHTS verpackt: wer immer den Schluessel
		// hinterlegt hat, bekaeme sonst den Tresorschluessel.
		const roh = await checkedPairingKey(getippt, publicKey).catch((e) => {
			logWarn("Kopplung abgebrochen: hinterlegter Schlüssel passt nicht zum Code");
			throw e;
		});

		const { wrapForDevice } = await import("../crypto/vault");
		const wrap = await wrapForDevice(this.#key, roh);
		await this.#api.pairApprove(getippt, JSON.stringify(serializeWrap(wrap)));
		logInfo("Gerät gekoppelt", { label });
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
		const roh = toBase64(new Uint8Array(await exportVaultKey(key)));
		const geschuetzterSchluessel = await protectSecret(roh);
		// Im Browser gibt es kein Geraete-Token: dort weist das Sitzungs-Cookie
		// aus. Der Tresorschluessel wird trotzdem abgelegt, damit die Anwendung
		// nach einem Neuladen nicht wieder nach der Anmeldung fragen muss.
		const geschuetztesToken = token ? await protectSecret(token) : null;

		const info = (await loadDevice()) ?? { id: this.#device };

		// Wessen Konto ist das? Zwei Konten haben verschiedene Tresorschluessel,
		// also verschiedene Nachweise.
		const kennung = await vaultProof(key);
		const wechsel = Boolean(info.kontoKennung && info.kontoKennung !== kennung);

		// Im Browser gibt es keinen Bestand ohne Konto - man kommt ohne Anmeldung
		// gar nicht hinein. Was hier liegt, ist die Kopie IRGENDEINES Kontos. Laesst
		// sich nicht beweisen, dass es dieses ist, kommt es weg; der Server hat es.
		// Auf dem Rechner sind die Zeiten die Sache des Menschen: sie bleiben, gehen
		// aber nicht hoch (siehe bestandGehoertZu).
		const fremdeKopie = !isTauri() && Boolean(info.kontoKennung && info.kontoKennung !== kennung);
		if (fremdeKopie) {
			await clearAccountData();
			logInfo("Kontowechsel: lokale Kopie des vorigen Kontos entfernt");
		}

		// Die Merkliste gehoert IMMER dem vorigen Konto - auf beiden Plattformen.
		// Ohne diese Zeile laedt sie der naechste Abgleich ins neue Konto: `#pushAll`
		// liest die Outbox, nicht den Stempel.
		if (wechsel || fremdeKopie) await clearOutbox();

		// Wem der Bestand gehoert: nach einem Wechsel weiterhin dem alten Konto
		// (dann bleibt er hier liegen), sonst diesem. Wer noch nie ein Konto hatte,
		// dessen Bestand ist der eigene und gehoert hoch.
		const bestandGehoertZu = wechsel && isTauri() ? info.bestandGehoertZu : kennung;

		await saveDevice({
			...info,
			id: this.#device,
			serverUrl: url,
			token: geschuetztesToken?.data,
			vaultKey: geschuetzterSchluessel.data,
			protected: geschuetzterSchluessel.protected && (geschuetztesToken?.protected ?? true),
			accountName: name || info.accountName,
			kontoKennung: kennung,
			bestandGehoertZu,
			seq: 0
		});
		this.name = name || this.name;

		this.serverUrl = url;
		this.secretsProtected = geschuetzterSchluessel.protected;
		this.hasDeviceToken = token !== null;
		this.state = "verbunden";
		await this.#startEngine(url, token, 0);
		void this.abgleichMitNachlese();
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
	async updateDisplayName(name: string): Promise<void> {
		if (!this.#api || !this.linked) return;
		const trimmed = name.trim();
		if (!trimmed) return;
		try {
			const res = await this.#api.updateMe({ displayName: trimmed });
			this.name = res.displayName;
			const info = await loadDevice();
			if (info) await saveDevice({ ...info, accountName: res.displayName });
		} catch (e) {
			logWarn("Anzeigename konnte nicht aktualisiert werden", e);
		}
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
		const ergebnis = await addPasskey(this.#api, this.#key, label);
		return { prfAvailable: ergebnis.prfAvailable };
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

	async createInvite(opts: { note?: string; gueltigTage?: number } = {}): Promise<Invite> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return this.#api.createInvite(opts);
	}

	async revokeInvite(code: string): Promise<void> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		await this.#api.revokeInvite(code);
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
		// Im Browser war der Bestand nur eine Kopie des Servers. Bliebe er liegen,
		// sieht der naechste Mensch an diesem Rechner die Zeiten des vorigen.
		if (!isTauri()) await clearAccountData();
	}

	/** Die Verknuepfung loesen. */
	async unlink(opts: UnlinkOptions = {}): Promise<DeleteSummary | null> {
		let summe: DeleteSummary | null = null;

		if (opts.deleteRemote || opts.revokeSelf) {
			if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
			// Zuerst der Server, solange Zugang und Token noch stehen. Danach ist
			// beides weg und der Vorgang liesse sich nicht mehr nachholen.
			if (opts.deleteRemote) {
				summe = await this.#api.deleteAccount(await this.#bestaetigung());
			} else {
				await this.#api.revokeDevice();
			}
		}

		await this.#forgetLocally();
		// Erst nachdem der Zugang wirklich weg ist: die Stempel abstreifen. Vorher
		// waere ein Abbruch mittendrin der schlechteste aller Zustaende - Daten
		// ohne Fassungsnummern, aber ein Konto, das sie noch erwartet.
		const geloest = await detachLocalData();
		logInfo("Verknüpfung gelöst", { ...opts, ...geloest });
		return summe;
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
		this.#closeStream();
		if (this.#debounce) clearTimeout(this.#debounce);
		if (this.#retry) clearTimeout(this.#retry);
		stopTracking();
		setChangeListener(null);
		this.#engine = null;
		this.#api = null;
		this.#key = null;
		const info = await loadDevice();
		if (info) {
			// Nur die Kontodaten loeschen, nicht die Geraetekennung: die soll
			// dieselbe bleiben, falls jemand erneut koppelt.
			await saveDevice({ id: info.id });
		}
		this.state = "aus";
		this.phase = "ruht";
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
