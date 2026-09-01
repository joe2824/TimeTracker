// Vorladen, sobald jemand die Absicht zeigt: Zeiger drauf, Fokus drauf, Finger drauf.
//
// Der Klick soll auf etwas treffen, das schon da ist. Bei schlechter Verbindung
// ist das der Unterschied zwischen "sofort" und "Ladebalken".
import { app } from "./app.svelte";
import { account } from "./sync/account.svelte";

interface Cached {
	promise: Promise<unknown>;
	at: number;
}

/** Wie lange ein vorgeladenes Ergebnis als frisch gilt. */
const DEFAULT_TTL_MS = 30_000;

/** Wie lange nach dem ersten Signal gewartet wird, bevor wirklich geladen wird. */
const DEFAULT_DELAY_MS = 100;

const cache = new Map<string, Cached>();

/**
 * Holen oder aus dem Puffer geben.
 *
 * Mehrfach hovern kostet nichts: das laufende Versprechen bleibt liegen, und ein
 * Klick mittendrin haengt sich daran an, statt eine zweite Anfrage zu starten.
 */
export function warm<T>(key: string, fn: () => Promise<T>, ttlMs = DEFAULT_TTL_MS): Promise<T> {
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < ttlMs) return hit.promise as Promise<T>;

	const promise = fn();
	cache.set(key, { promise, at: Date.now() });
	// Ein Fehlschlag darf sich nicht einbrennen: der naechste Versuch soll wieder
	// wirklich fragen, statt denselben Fehler aus dem Puffer zu wiederholen.
	void promise.catch(() => {
		if (cache.get(key)?.promise === promise) cache.delete(key);
	});
	return promise;
}

/** Einen Puffer verwerfen - etwa nachdem ein Passkey dazugekommen ist. */
export function invalidate(key: string): void {
	cache.delete(key);
}

/** Alles verwerfen. Beim Kontowechsel: der Puffer gehoert dem vorigen Konto. */
export function invalidateAll(): void {
	cache.clear();
}

/**
 * Ein einziger schwebender Anlauf - es gibt nur einen Zeiger.
 *
 * Modulweit statt je Element: die Handler unten werden bei jedem Rendern neu
 * gebaut, ein Timer in ihrer Closure ueberlebte das Verlassen des Elements nicht.
 */
let pending: ReturnType<typeof setTimeout> | null = null;

function cancelIntent(): void {
	if (pending === null) return;
	clearTimeout(pending);
	pending = null;
}

/**
 * Event-Handler, die melden, sobald jemand auf ein Element zusteuert.
 *
 * Zeiger drauf, Tastaturfokus drauf oder Finger drauf - auf einem Touchgeraet
 * gibt es kein Hover, dort ist die Beruehrung das frueheste Signal.
 *
 * Als Handler und nicht als `use:`-Action, weil die Ziele hier Komponenten sind
 * (Button, Select.Item, Tabs.Trigger) und Actions nur an Elemente duerfen.
 *
 * ```svelte
 * <Button {...onIntent(() => prefetchMonth(m))}>
 * ```
 */
export function onIntent(run: () => void, delay = DEFAULT_DELAY_MS) {
	const start = () => {
		// Entprellt: ohne das loest eine Maus, die ueber die Tab-Leiste wischt,
		// jedes Ziel darin aus.
		cancelIntent();
		pending = setTimeout(() => {
			pending = null;
			run();
		}, delay);
	};
	return {
		onpointerenter: start,
		onpointerleave: cancelIntent,
		onfocus: start,
		onblur: cancelIntent,
		ontouchstart: start
	};
}

// ---------- Was wo vorgeladen wird ----------

/** Puffer-Schluessel des Kontos: Anmeldung, Geraete und Passkeys in einem Zug. */
export const ACCOUNT_KEY = "account";

/**
 * Konto, Geraete und Passkeys.
 *
 * Eine Anfrage fuer alle drei: `AccountInfo` bringt `devices` und `passkeys`
 * bereits mit.
 */
export function prefetchAccount(): Promise<unknown> {
	if (!account.linked) return Promise.resolve(null);
	return warm(ACCOUNT_KEY, () => account.accountInfo()).catch(() => null);
}

export const INVITES_KEY = "invites";
export const BACKUPS_KEY = "backups";

/** Einladungen und Sicherungen - nur, wenn jemand ueberhaupt Verwalter ist. */
export function prefetchAdmin(): Promise<unknown> {
	if (!account.linked || !account.isAdmin) return Promise.resolve(null);
	return Promise.all([
		warm(INVITES_KEY, () => account.invites()).catch(() => null),
		warm(BACKUPS_KEY, () => account.backups()).catch(() => null)
	]);
}

/** Alles, was der Einstellungsbereich vom Server braucht. */
export async function prefetchSettings(): Promise<void> {
	// Nacheinander: erst nach `accountInfo` steht fest, ob es Verwaltungsdaten
	// ueberhaupt zu holen gibt.
	await prefetchAccount();
	await prefetchAdmin();
}

/** Puffer-Schluessel der Monatsliste vom Server. */
export const REMOTE_MONTHS_KEY = "months:remote";

/**
 * Welche Monate der Server kennt - fuer die Auswahl, solange der Backfill laeuft.
 *
 * Laenger gepuffert als der Rest: die Liste aendert sich nur, wenn irgendwo ein
 * neuer Monat entsteht, und sie haengt an einer Auswahl, die auf jeder Ansicht
 * steht.
 */
export function prefetchRemoteMonths(): Promise<string[]> {
	if (!account.linked) return Promise.resolve([]);
	return warm(REMOTE_MONTHS_KEY, () => account.remoteMonths(), 5 * 60_000).catch(() => []);
}

/**
 * Einen Monat bereitlegen: erst vom Server, dann von der Platte in den Speicher.
 *
 * Beide Schritte gehoeren zusammen - ohne den zweiten liegt der Monat zwar auf
 * der Platte, aber die Ansicht kennt ihn noch nicht.
 */
export function prefetchMonth(month: string): Promise<unknown> {
	// Bei fehlender Verbindung gar nicht erst anfangen: der Abgleich versucht es
	// ohnehin wieder, und ein Prefetch ins Leere kostet nur Wartezeit.
	if (account.phase === "offline") return Promise.resolve(null);
	return warm(`month:${month}`, () => app.ensureMonth(month)).catch(() => null);
}

// Beim Abmelden den Puffer leeren: er gehoert dem vorigen Konto. Dieser Aufruf
// steht hier statt in account.svelte.ts, weil dort kein Import von prefetch
// erlaubt ist (prefetch importiert seinerseits account - Kreis).
account.setLogoutHook(invalidateAll);
