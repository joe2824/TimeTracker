// Ein Konto anlegen und sich anmelden.
//
// Beides passiert im Browser - Passkeys sind an die Domain gebunden, und die
// Desktop-Anwendung hat keine. Sie koppelt sich stattdessen an ein Geraet, das
// schon Zugriff hat (siehe account.svelte.ts).
//
// Der heikle Teil ist nicht die Anmeldung, sondern der Tresorschluessel: er
// entsteht hier, verlaesst dieses Geraet nie im Klartext, und er muss auf
// MINDESTENS zwei Wegen wieder zu oeffnen sein. Sonst haengt alles an einem
// einzigen Passkey - und wenn das Handy im See liegt, sind die Daten weg.
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type {
	AuthenticationResponseJSON,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
	RegistrationResponseJSON
} from "@simplewebauthn/browser";
import {
	createRecoveryPhrase,
	createVaultKey,
	fromBase64,
	importVaultKey,
	isValidRecoveryPhrase,
	recoveryLookupId,
	toBase64,
	unwrapWithPhrase,
	unwrapWithPrf,
	vaultProof,
	wrapWithPhrase,
	wrapWithPrf,
	type KeyWrap
} from "../crypto/vault";
import { Api, ApiError } from "./api";
import { platformFetch } from "../platform/http";

/** Was der Server unter einer Verpackung versteht: JSON mit base64-Feldern. */
function serialize(wrap: KeyWrap): string {
	return JSON.stringify({
		kind: wrap.kind,
		salt: toBase64(wrap.salt),
		iv: toBase64(wrap.iv),
		wrapped: toBase64(wrap.wrapped),
		...(wrap.ephemeralPublicKey
			? { ephemeralPublicKey: toBase64(wrap.ephemeralPublicKey) }
			: {})
	});
}

function deserialize(payload: string): KeyWrap {
	const d = JSON.parse(payload);
	return {
		kind: d.kind,
		salt: fromBase64(d.salt),
		iv: fromBase64(d.iv),
		wrapped: fromBase64(d.wrapped),
		...(d.ephemeralPublicKey ? { ephemeralPublicKey: fromBase64(d.ephemeralPublicKey) } : {})
	};
}

/**
 * Feste Eingabe fuer die PRF-Erweiterung.
 *
 * Sie muss bei jeder Anmeldung dieselbe sein - derselbe Passkey plus dieselbe
 * Eingabe ergibt denselben Wert, und genau daran haengt, dass der Tresor sich
 * wieder oeffnet. Sie ist kein Geheimnis; das Geheimnis steckt im Passkey.
 */
const PRF_INPUT = new TextEncoder().encode("timetracker-vault-v1");

/** Was ein Authentifikator zurueckgab, sofern er PRF kann. */
function prfOf(response: RegistrationResponseJSON | AuthenticationResponseJSON): ArrayBuffer | null {
	const ext = response.clientExtensionResults as {
		prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | Uint8Array } };
	};
	const first = ext?.prf?.results?.first;
	if (!first) return null;
	return first instanceof Uint8Array ? (first.buffer as ArrayBuffer) : first;
}

/**
 * Die PRF-Eingabe an die Optionen haengen.
 *
 * Der Server stellt die Aufgabe, die EINGABE fuer die Erweiterung kommt von
 * hier: sie ist kein Geheimnis und muss auf jedem Geraet dieselbe sein, sonst
 * faellt bei jeder Anmeldung ein anderer Wert heraus.
 *
 * Der Cast ist noetig, weil die Typdefinition des Browsers `prf` noch nicht
 * kennt - die Erweiterung ist neuer als die Typen.
 */
function withPrf<T extends { extensions?: unknown }>(options: T): T {
	return {
		...options,
		extensions: {
			...((options.extensions as Record<string, unknown> | undefined) ?? {}),
			prf: { eval: { first: PRF_INPUT } }
		}
	} as T;
}

export interface EnrollResult {
	userId: string;
	displayName: string;
	/** Nur bei der Registrierung: einmal anzeigen, danach nie wieder. */
	recoveryPhrase?: string;
	/** Ob der Passkey den Tresor kuenftig allein oeffnen kann. */
	prfAvailable: boolean;
	key: CryptoKey;
}

/**
 * Ein neues Konto anlegen.
 *
 * Die Reihenfolge ist Absicht: erst der Passkey (dort kann der Nutzer noch
 * abbrechen), dann der Schluessel, dann die Verpackungen. Ein Konto ohne
 * Verpackung waere ein Tresor ohne jeden Schluessel - deshalb wird die
 * Phrasen-Verpackung IMMER abgelegt, auch wenn der Passkey PRF kann.
 */
export async function register(
	baseUrl: string,
	displayName: string,
	opts: { invite?: string; email?: string } = {}
): Promise<EnrollResult> {
	const api = new Api({ baseUrl, fetchFn: platformFetch });

	const start = await api.registerStart(displayName, opts.invite);
	const response = await startRegistration({
		optionsJSON: withPrf(start.options as PublicKeyCredentialCreationOptionsJSON)
	});

	const prf = prfOf(response);
	await api.registerFinish({
		challengeId: start.challengeId,
		displayName,
		invite: opts.invite,
		email: opts.email,
		hasPrf: prf !== null,
		response
	});

	// Ab hier ist die Sitzung offen und die Verpackungen koennen abgelegt werden.
	const key = await createVaultKey();
	const recoveryPhrase = createRecoveryPhrase();
	await api.putWrap("recovery", serialize(await wrapWithPhrase(key, recoveryPhrase)), undefined, {
		recoveryId: await recoveryLookupId(recoveryPhrase),
		vaultProof: await vaultProof(key)
	});
	if (prf) {
		await api.putWrap("passkey", serialize(await wrapWithPrf(key, prf)), response.id);
	}

	return {
		userId: start.userId,
		displayName,
		recoveryPhrase,
		prfAvailable: prf !== null,
		key
	};
}

export interface LoginResult {
	userId: string;
	displayName: string;
	/** Der Tresorschluessel - oder null, wenn er noch entsperrt werden muss. */
	key: CryptoKey | null;
	/** Ob eine Phrasen-Verpackung vorliegt, mit der entsperrt werden kann. */
	canUnlockWithPhrase: boolean;
	/**
	 * Was der Authentifikator ueber PRF ausgegeben hat, samt der Kennung des
	 * benutzten Passkeys. Null, wenn er PRF nicht kann.
	 *
	 * Reist mit, damit der Aufrufer nach einem Entsperren ueber die Phrase eine
	 * PRF-Verpackung nachlegen kann - siehe `addPasskeyWrap`. Beides ist in
	 * diesem Moment noch da und spaeter nicht mehr zu bekommen: der Wert faellt
	 * nur bei einer Anmeldung an, und eine zweite dafuer waere ein zweiter
	 * Passkey-Dialog fuer etwas, das niemand angefordert hat.
	 */
	prf: ArrayBuffer | null;
	/** Die Kennung des benutzten Passkeys - an ihr haengt die PRF-Verpackung. */
	credentialId: string;
}

/**
 * Anmelden.
 *
 * Wenn der Passkey PRF kann und dafuer eine Verpackung vorliegt, ist der Tresor
 * in derselben Bewegung offen. Sonst kommt der Schluessel `null` zurueck und der
 * Aufrufer fragt nach der Phrase - das ist kein Fehler, sondern der normale Weg
 * auf Geraeten ohne PRF.
 */
export async function login(baseUrl: string): Promise<LoginResult> {
	const api = new Api({ baseUrl, fetchFn: platformFetch });
	const start = await api.loginStart();
	const response = await startAuthentication({
		optionsJSON: withPrf(start.options as PublicKeyCredentialRequestOptionsJSON)
	});
	const konto = await api.loginFinish({ challengeId: start.challengeId, response });

	const { wraps } = await api.wraps();
	const prf = prfOf(response);
	const passkeyWrap = wraps.find((w) => w.kind === "passkey" && w.credentialId === response.id);

	let key: CryptoKey | null = null;
	if (prf && passkeyWrap) {
		try {
			key = await unwrapWithPrf(deserialize(passkeyWrap.payload), prf);
		} catch {
			// Der Authentifikator hat einen Wert geliefert, aber nicht den, mit dem
			// verpackt wurde - etwa nach einem Wechsel des Passkey-Verwalters. Dann
			// bleibt die Phrase, statt hier abzubrechen.
			key = null;
		}
	}

	return {
		userId: konto.userId,
		displayName: konto.displayName,
		key,
		canUnlockWithPhrase: wraps.some((w) => w.kind === "recovery"),
		prf,
		credentialId: response.id
	};
}

/** Den Tresor mit der Wiederherstellungs-Phrase oeffnen. */
export async function unlockWithPhrase(baseUrl: string, phrase: string): Promise<CryptoKey> {
	const api = new Api({ baseUrl, fetchFn: platformFetch });
	const { wraps } = await api.wraps();
	const wrap = wraps.find((w) => w.kind === "recovery");
	if (!wrap) throw new Error("Für dieses Konto ist keine Wiederherstellungs-Phrase hinterlegt.");
	return unwrapWithPhrase(deserialize(wrap.payload), phrase);
}

/**
 * Nach einer Anmeldung ohne PRF-Verpackung: eine anlegen.
 *
 * Damit oeffnet der Passkey den Tresor beim naechsten Mal allein. Passiert
 * stillschweigend im Hintergrund - es gibt nichts zu entscheiden, und ein
 * Dialog dafuer waere reine Stoerung.
 *
 * Aufgerufen wird das nach dem Entsperren ueber die Phrase (WebOnboarding).
 * Ohne diesen Aufruf blieb es bei der Absicht: ein Geraet, dessen Passkey PRF
 * kann, dessen Verpackung aber fehlt oder nicht mehr passt, verlangte bei JEDER
 * Anmeldung erneut die 24 Woerter - genau das, was hier verhindert werden soll.
 */
export async function addPasskeyWrap(
	baseUrl: string,
	key: CryptoKey,
	credentialId: string,
	prf: ArrayBuffer
): Promise<void> {
	const api = new Api({ baseUrl, fetchFn: platformFetch });
	await api.putWrap("passkey", serialize(await wrapWithPrf(key, prf)), credentialId);
}

/**
 * Ein Konto allein mit der Wiederherstellungs-Phrase zurueckholen.
 *
 * Der Weg fuer den Tag, an dem sonst nichts mehr da ist: Rechner kaputt, kein
 * zweites Geraet, kein Passkey. In der Hand sind 24 Woerter.
 *
 * Zwei Schritte, und der zweite ist der Grund fuer beide: erst die Verpackung
 * holen (die Kennung sagt nur, WELCHES Konto gemeint ist), dann oeffnen, dann
 * nachweisen, dass es gelungen ist. Erst danach gibt es ein Geraete-Token.
 * Ohne diesen Nachweis genuegte die Kennung - und wer sie aus einer gestohlenen
 * Datenbank abliest, koennte die Chiffrate loeschen, ohne je etwas
 * entschluesselt zu haben.
 */
export async function recoverWithPhrase(
	baseUrl: string,
	phrase: string,
	label: string
): Promise<{ userId: string; displayName: string; deviceToken: string; key: CryptoKey }> {
	if (!isValidRecoveryPhrase(phrase)) {
		throw new Error("Das sind nicht 24 gültige Wörter – bitte noch einmal prüfen.");
	}
	const api = new Api({ baseUrl, fetchFn: platformFetch });
	const recoveryId = await recoveryLookupId(phrase);

	const { wrap } = await api.recoverWrap(recoveryId);
	// Hier faellt die Entscheidung: passen die Woerter nicht, geht das Chiffrat
	// nicht auf. Der Server hat damit nichts zu tun und erfaehrt es auch nicht.
	const key = await unwrapWithPhrase(deserialize(wrap), phrase);

	const angemeldet = await api.recoverDevice({
		recoveryId,
		proof: await vaultProof(key),
		label
	});

	return {
		userId: angemeldet.userId,
		displayName: angemeldet.displayName,
		deviceToken: angemeldet.deviceToken,
		key
	};
}

/**
 * Ein Konto von diesem Geraet aus anlegen - ohne Passkey.
 *
 * Der Weg fuer die Desktop-Anwendung. Sie hat keine Domain und kann deshalb
 * keinen Passkey anbieten; sie bekommt ein Geraete-Token und legt die
 * Wiederherstellungs-Phrase als einzige Verpackung ab.
 *
 * Das ist ausdruecklich ein Konto mit EINEM Weg zurueck. Solange kein zweites
 * Geraet gekoppelt und kein Passkey angelegt ist, haengt alles an diesen 24
 * Woertern - deshalb gibt diese Funktion sie zurueck und die Oberflaeche zeigt
 * sie, bevor irgendetwas anderes passiert.
 */
export async function registerFromDevice(
	baseUrl: string,
	/** Leer lassen: dann steht die Kennung des Kontos da. Siehe /api/auth/device. */
	displayName: string,
	label: string,
	opts: { invite?: string; email?: string } = {}
): Promise<{
	userId: string;
	displayName: string;
	deviceToken: string;
	key: CryptoKey;
	recoveryPhrase: string;
}> {
	const api = new Api({ baseUrl, fetchFn: platformFetch });
	const angelegt = await api.registerDevice({
		displayName,
		label,
		invite: opts.invite,
		email: opts.email
	});

	// Ab hier weist sich dieses Geraet mit seinem Token aus - vorher gab es
	// nichts, womit.
	api.setToken(angelegt.deviceToken);

	const key = await createVaultKey();
	const recoveryPhrase = createRecoveryPhrase();
	// Die Phrase zuerst: sie ist der einzige Weg zurueck, und ein Konto, dessen
	// Verpackung nicht abgelegt werden konnte, ist ein Konto ohne Zugriff auf die
	// eigenen Daten. Scheitert das hier, scheitert das Anlegen sichtbar - statt
	// still ein unbrauchbares Konto zu hinterlassen.
	await api.putWrap("recovery", serialize(await wrapWithPhrase(key, recoveryPhrase)), undefined, {
		recoveryId: await recoveryLookupId(recoveryPhrase),
		vaultProof: await vaultProof(key)
	});

	return {
		userId: angelegt.userId,
		displayName: angelegt.displayName,
		deviceToken: angelegt.deviceToken,
		key,
		recoveryPhrase
	};
}

/**
 * Einen WEITEREN Passkey an ein bestehendes Konto haengen.
 *
 * Zwei Dinge passieren, und beide muessen passieren:
 *
 *   1. Der Passkey wird beim Server hinterlegt - damit meldet er an.
 *   2. Der Tresorschluessel wird gegen ihn verpackt - damit oeffnet er die Daten.
 *
 * Ohne den zweiten Schritt haette man einen Passkey, der zwar hineinkommt, aber
 * vor verschlossenen Daten steht. Das ist der unangenehmste Zustand von allen:
 * es sieht aus, als sei alles in Ordnung, bis der erste Passkey weg ist.
 *
 * Schritt 2 geht nur, wenn der Authentifikator PRF kann. Kann er es nicht,
 * bleibt der Passkey trotzdem nuetzlich - er meldet an, und die Daten oeffnet
 * dann die Phrase oder ein bereits entsperrtes Geraet. Das Ergebnis sagt, was
 * von beidem der Fall ist, damit die Oberflaeche nichts verspricht.
 */
export async function addPasskey(
	baseUrl: string,
	key: CryptoKey,
	label: string
): Promise<{ id: string; label: string | null; prfAvailable: boolean }> {
	const api = new Api({ baseUrl, fetchFn: platformFetch });
	const { challengeId, options } = await api.addPasskeyStart();

	const response = await startRegistration({
		optionsJSON: withPrf(options as Parameters<typeof startRegistration>[0]["optionsJSON"])
	});

	const prf = prfOf(response);
	const angelegt = await api.addPasskeyFinish({
		challengeId,
		label,
		hasPrf: prf !== null,
		response
	});

	// Erst jetzt die Verpackung: sie braucht die Kennung, die der Server gerade
	// vergeben hat. Scheitert sie, bleibt ein Passkey ohne Zugriff auf die Daten
	// zurueck - deshalb sagt das Ergebnis es dem Aufrufer, statt es zu verschweigen.
	if (prf) await api.putWrap("passkey", serialize(await wrapWithPrf(key, prf)), angelegt.id);

	return { id: angelegt.id, label: angelegt.label, prfAvailable: prf !== null };
}

export { ApiError, importVaultKey, toBase64 };
