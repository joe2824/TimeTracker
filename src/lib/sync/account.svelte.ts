// Das Konto, wie die Oberflaeche es sieht.
import { app } from "../app.svelte";
import { logError, logInfo, logWarn } from "../log";
import { loadDevice, loadEntries, saveDevice, saveEntries } from "../store";
import { loadActivities, saveActivities, loadSettings, saveSettings, listEntryMonths } from "../store";
import { deviceId } from "./device";
import { startTracking, stopTracking, pendingChanges, setChangeListener } from "./outbox";
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
	toBase64,
	unwrapForDevice,
	type KeyWrap
} from "../crypto/vault";
import { protectSecret, unprotectSecret } from "../platform/secrets";
import { isTauri } from "../platform/env";
import { platformFetch } from "../platform/http";

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

/** Wie lange nach einer Aenderung gewartet wird, bevor hochgeladen wird. */
const DEBOUNCE_MS = 1500;

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

	#api: Api | null = null;
	#engine: SyncEngine | null = null;
	#key: CryptoKey | null = null;
	#stream: EventSource | null = null;
	#debounce: ReturnType<typeof setTimeout> | null = null;
	#retry: ReturnType<typeof setTimeout> | null = null;
	#retryStep = 0;
	#device = "";
	#heartbeat: ReturnType<typeof setInterval> | null = null;

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
			void this.syncSoon(0);
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

		if (isTauri()) {
			this.#startHeartbeat();
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
	#pairing: { pair: CryptoKeyPair; code: string; url: string } | null = null;

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
		const antwort = await api.pairStart(publicKey, label, code);

		// Und was er zurueckgibt, muss dasselbe sein. Ein Server, der einen anderen
		// Code herausgibt, brauchte ihn nur, um ihn auf den Bildschirm zu bekommen:
		// der Mensch traegt ihn drueben ein, drueben liegt dann ein Schluessel, der
		// zu DIESEM Code passt - und das waere nicht mehr unserer.
		if (antwort.code !== code) {
			throw new Error("Der Server hat einen anderen Kopplungscode zurückgegeben.");
		}

		this.#pairing = { pair, code, url };
		return code;
	}

	/** Schritt 3: nachsehen, ob jemand bestaetigt hat. */
	async checkPairing(): Promise<boolean> {
		if (!this.#pairing) return false;
		const { pair, code, url } = this.#pairing;
		const api = new Api({ baseUrl: url, fetchFn: platformFetch });
		const antwort = await api.pairClaim(code);
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
		await saveDevice({
			...info,
			id: this.#device,
			serverUrl: url,
			token: geschuetztesToken?.data,
			vaultKey: geschuetzterSchluessel.data,
			protected: geschuetzterSchluessel.protected && (geschuetztesToken?.protected ?? true),
			accountName: name || info.accountName,
			seq: 0
		});
		this.name = name || this.name;

		this.serverUrl = url;
		this.secretsProtected = geschuetzterSchluessel.protected;
		this.hasDeviceToken = token !== null;
		this.state = "verbunden";
		await this.#startEngine(url, token, 0);
		// Der erste Abgleich laedt den gesamten lokalen Bestand hoch. Ohne
		// verknuepftes Konto ist nichts gestempelt, also gilt alles als neu - genau
		// das ist gewollt.
		void this.syncNow();
	}

	/** Nachsehen, was am Konto haengt - vor allem, wie viele Geraete. */
	async accountInfo(): Promise<AccountInfo | null> {
		if (!this.#api) return null;
		const info = await this.#api.me();
		this.isAdmin = info.isAdmin;
		return info;
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
		const { addPasskey } = await import("./enroll");
		const ergebnis = await addPasskey(this.serverUrl, this.#key, label);
		return { prfAvailable: ergebnis.prfAvailable };
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

	async invites(): Promise<Invite[]> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return (await this.#api.invites()).invites;
	}

	async createInvite(opts: { note?: string; gueltigTage?: number } = {}): Promise<Invite> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		return this.#api.createInvite(opts);
	}

	async revokeInvite(code: string): Promise<void> {
		if (!this.#api) throw new Error("Dieses Gerät ist nicht verknüpft");
		await this.#api.revokeInvite(code);
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
