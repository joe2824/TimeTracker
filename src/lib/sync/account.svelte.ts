// Das Konto, wie die Oberflaeche es sieht.
//
// Hier laufen die Teile zusammen: Geraetekennung, Tresorschluessel, die
// Abgleich-Maschine und der Weckruf-Kanal. Nach aussen sind es ein Zustand und
// eine Handvoll Befehle - alles darunter bleibt hier.
//
// Ohne verknuepftes Konto ist dieses Modul untaetig und der Schreib-Haken nicht
// gesetzt: das Programm verhaelt sich dann Zeile fuer Zeile wie zuvor.
import { app } from "../app.svelte";
import { logError, logInfo, logWarn } from "../log";
import { loadDevice, loadEntries, saveDevice, saveEntries } from "../store";
import { loadActivities, saveActivities, loadSettings, saveSettings, listEntryMonths } from "../store";
import { deviceId } from "./device";
import { startTracking, stopTracking, pendingChanges, setChangeListener } from "./outbox";
import { Api, ApiError, type AccountInfo, type DeleteSummary, type Invite } from "./api";
import { detachLocalData } from "./detach";
import { SyncEngine } from "./engine";
import {
	createPairingKeyPair,
	createVaultKey,
	exportPairingPublicKey,
	exportVaultKey,
	fromBase64,
	importVaultKey,
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

/**
 * Wie lange nach einer Aenderung gewartet wird, bevor hochgeladen wird.
 *
 * Sammelt zusammen, was zusammengehoert: wer im Eintrags-Dialog tippt, loest
 * sonst mit jedem Zeichen eine Anfrage aus. Kurz genug, dass ein Start am
 * Rechner am Handy sofort ankommt.
 */
const DEBOUNCE_MS = 1500;

/**
 * Abstand zwischen zwei Verbindungsversuchen, wachsend.
 *
 * Ein Server, der gerade neu startet, soll nicht von einem Geraet bestuermt
 * werden, das im Sekundentakt anklopft.
 */
const RETRY_MS = [5_000, 15_000, 60_000, 300_000];

/**
 * Der langsame Takt, wo es keinen Weckruf-Kanal gibt.
 *
 * Fuenf Minuten: zwoelf Anfragen je Stunde, jede davon ein leeres Delta von
 * wenigen Bytes. Wer schneller sein will, bringt das Fenster in den
 * Vordergrund - das gleicht sofort ab.
 */
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
	/**
	 * Darf dieses Konto Einladungen vergeben?
	 *
	 * Wird beim Verbinden vom Server geholt, nicht lokal gemerkt: eine Rolle, die
	 * das Geraet selbst behauptet, waere keine. Die Oberflaeche benutzt das nur,
	 * um den Bereich zu zeigen - erlaubt wird ohnehin auf dem Server.
	 */
	isAdmin = $state<boolean>(false);

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

	/**
	 * Beim Programmstart: falls ein Konto verknuepft ist, alles hochfahren.
	 *
	 * Scheitert das, bleibt es beim lokalen Betrieb - ein nicht erreichbarer
	 * Server darf den Start nicht aufhalten.
	 */
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

	/**
	 * Bald abgleichen.
	 *
	 * Aufrufe sammeln sich: wer im Dialog tippt, loest damit eine Anfrage aus,
	 * nicht zwanzig.
	 */
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

	/**
	 * Auf Aenderungen anderer Geraete hoeren.
	 *
	 * Der Weckruf-Kanal laeuft ueber EventSource - und der kann keine Kopfzeilen
	 * mitgeben. Er weist sich deshalb ueber das Sitzungs-Cookie aus, was im
	 * Browser der normale Weg ist.
	 *
	 * In der Desktop-Anwendung gibt es dieses Cookie nicht: sie meldet sich mit
	 * einem Geraete-Token an, und das gehoert nicht in eine Adresse - dort landet
	 * es in jedem Server-Protokoll und in jeder Zwischenstation. Statt diesen
	 * Preis zu zahlen, kommt sie ohne Kanal aus: sie gleicht ab, wenn sich lokal
	 * etwas aendert, wenn das Fenster wieder in den Vordergrund kommt, und
	 * ansonsten im langsamen Takt. Das kostet zwoelf Anfragen je Stunde und
	 * traegt genau den Fall, um den es geht - der Rechner war aus, und was am
	 * Handy passiert ist, kommt beim Aufwachen an.
	 */
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

	/**
	 * Das Fenster kommt in den Vordergrund.
	 *
	 * Der wichtigste Zeitpunkt ueberhaupt: wer den Rechner aufklappt, will den
	 * Stand von unterwegs sehen - nicht erst nach dem naechsten Takt.
	 */
	onVisible(): void {
		if (this.state === "verbunden") this.syncSoon(0);
	}

	#closeStream(): void {
		this.#stream?.close();
		this.#stream = null;
		this.#stopHeartbeat();
	}

	// ---------- Koppeln: dieses Geraet ist neu ----------

	/**
	 * Schritt 1: einen Kopplungscode holen.
	 *
	 * Das fluechtige Schluesselpaar bleibt im Speicher dieses Vorgangs - es
	 * ueberdauert bewusst keinen Neustart. Wer den Vorgang abbricht, faengt neu
	 * an; ein herumliegender privater Schluessel waere ein Angriffsziel ohne
	 * Nutzen.
	 */
	#pairing: { pair: CryptoKeyPair; code: string; url: string } | null = null;

	async startPairing(serverUrl: string, label: string): Promise<string> {
		const url = serverUrl.replace(/\/+$/, "");
		const api = new Api({ baseUrl: url, fetchFn: platformFetch });
		const pair = await createPairingKeyPair();
		const publicKey = toBase64(await exportPairingPublicKey(pair));
		const { code } = await api.pairStart(publicKey, label);
		this.#pairing = { pair, code, url };
		return code;
	}

	/**
	 * Schritt 3: nachsehen, ob jemand bestaetigt hat.
	 *
	 * Wird von der Oberflaeche in Abstaenden gerufen, solange der Dialog offen
	 * ist. Kein Kanal, kein Warten am Server: der Vorgang dauert Sekunden und
	 * jemand sieht dabei zu.
	 */
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

	/**
	 * Einen Code bestaetigen.
	 *
	 * Der Tresorschluessel wird gegen den oeffentlichen Schluessel des neuen
	 * Geraets verpackt und beim Server abgelegt. Der sieht dabei nur Chiffrat -
	 * er verwahrt das Paket, oeffnen kann es nur das Geraet, das den Code
	 * angezeigt hat.
	 */
	async approvePairing(code: string): Promise<string> {
		if (!this.#api || !this.#key) throw new Error("Dieses Gerät ist nicht verknüpft");
		const { publicKey, label } = await this.#api.pairLookup(code);
		const { wrapForDevice } = await import("../crypto/vault");
		const wrap = await wrapForDevice(this.#key, fromBase64(publicKey));
		await this.#api.pairApprove(code, JSON.stringify(serializeWrap(wrap)));
		logInfo("Gerät gekoppelt", { label });
		return label;
	}

	/**
	 * Nach Registrierung oder Anmeldung im Browser: die Verknuepfung uebernehmen.
	 *
	 * Ohne Geraete-Token - die Sitzung steckt im Cookie. Laeuft es ab, meldet der
	 * Server 401 und die Oberflaeche fragt neu nach dem Passkey.
	 */
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
		this.state = "verbunden";
		await this.#startEngine(url, token, 0);
		// Der erste Abgleich laedt den gesamten lokalen Bestand hoch. Ohne
		// verknuepftes Konto ist nichts gestempelt, also gilt alles als neu - genau
		// das ist gewollt.
		void this.syncNow();
	}

	/**
	 * Nachsehen, was am Konto haengt - vor allem, wie viele Geraete.
	 *
	 * Die Oberflaeche fragt das, bevor sie das Entkoppeln anbietet: bei genau
	 * einem Geraet ist "loesen" und "aufloesen" dasselbe, bei mehreren nicht,
	 * und dieser Unterschied gehoert vor die Entscheidung, nicht danach.
	 */
	async accountInfo(): Promise<AccountInfo | null> {
		if (!this.#api) return null;
		const info = await this.#api.me();
		this.isAdmin = info.isAdmin;
		return info;
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

	/**
	 * Die Verknuepfung loesen.
	 *
	 * Drei Abstufungen, weil "entkoppeln" drei verschiedene Dinge heissen kann:
	 *
	 *   nichts angegeben  - nur dieses Geraet vergisst das Konto. Der Zugang
	 *                       bleibt gueltig; wer das Geraet hat, koppelt es
	 *                       wieder. Fuer den Fall "ich will hier gerade nicht
	 *                       abgleichen".
	 *   revokeSelf        - der Zugang DIESES Geraets erlischt auch beim Server.
	 *                       Das Konto und die anderen Geraete bleiben. Der
	 *                       Normalfall beim Weggeben eines Rechners.
	 *   deleteRemote      - das ganze Konto wird aufgeloest. Alles, was der
	 *                       Server hat, verschwindet: Chiffrate, Passkeys,
	 *                       verpackte Schluessel, alle Geraete. Auch die der
	 *                       anderen.
	 *
	 * In JEDEM dieser Faelle bleiben die lokalen Daten vollstaendig erhalten.
	 * Sie waren vor der Verknuepfung da und sind danach immer noch da; nur die
	 * Herkunftsspuren des Abgleichs fallen weg. Der Server war nie ihre einzige
	 * Kopie, und das ist der Punkt, an dem sich das beweist.
	 *
	 * Scheitert die Serverseite, bricht der Vorgang ab und lokal bleibt alles,
	 * wie es war. Das ist wichtiger, als es aussieht: waere es andersherum,
	 * haette jemand mit einem kurz nicht erreichbaren Server am Ende ein Geraet
	 * ohne Zugang und Daten, die trotzdem noch beim Server liegen - und keine
	 * Moeglichkeit mehr, sie loeschen zu lassen.
	 */
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

	/**
	 * Den Menschen bestaetigen lassen - mit dem Passkey, nicht mit einem Haken.
	 *
	 * Auf dem Desktop entfaellt das: dort weist sich die Anwendung mit dem
	 * Geraete-Token aus, und einen Passkey kann sie gar nicht anbieten - der
	 * Webview hat eine andere Herkunft als die Domain, an die Passkeys gebunden
	 * sind. Der Server laesst das Token deshalb ausdruecklich genuegen.
	 */
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
