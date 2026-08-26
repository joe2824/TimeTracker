// Eine Bremse fuer die Endpunkte, die ohne Anmeldung erreichbar sind.
//
// Warum ueberhaupt: die Kopplung gibt bei einem Treffer ein Geraete-Token
// heraus, und der Code dafuer ist acht Zeichen lang. Vierzig Bit sind rechnerisch
// nicht zu raten - aber "rechnerisch nicht" ist eine Aussage ueber einen
// Angreifer, der ehrlich rechnet, und keine ueber einen, der einfach sehr oft
// fragt. Eine zweite Linie kostet hier fast nichts.
//
// Absichtlich im Prozessgedaechtnis und nicht in der Datenbank: eine Bremse, die
// bei jedem Versuch schreibt, ist selbst der Angriffspunkt. Bei mehr als einer
// Instanz gehoert das nach Redis - dieselbe Ausbaustufe wie das Weiterreichen
// der Ereignisse, und aus demselben Grund.

/** Ein Eimer je Schluessel: wie viel noch drin ist, und wann zuletzt aufgefuellt wurde. */
interface Bucket {
	tokens: number;
	last: number;
}

const eimer = new Map<string, Bucket>();

export interface LimitOptions {
	/** Wie viele Versuche in Folge erlaubt sind, wenn nichts nachfliesst. */
	burst: number;
	/** Wie viele Versuche je Minute nachfliessen. */
	perMinute: number;
}

/**
 * Einen Versuch anmelden.
 *
 * Gibt zurueck, ob er erlaubt ist - und wie lange zu warten waere, wenn nicht.
 * Ein Token-Eimer statt eines Zaehlers je Zeitfenster: an der Fenstergrenze
 * liesse ein Zaehler die doppelte Menge durch.
 */
export function nimmVersuch(
	schluessel: string,
	opts: LimitOptions,
	jetzt = Date.now()
): { erlaubt: boolean; retryAfter: number } {
	const rate = opts.perMinute / 60_000;
	const vorhanden = eimer.get(schluessel);
	const b = vorhanden ?? { tokens: opts.burst, last: jetzt };

	// Auffuellen fuer die verstrichene Zeit, aber nie ueber den Rand.
	b.tokens = Math.min(opts.burst, b.tokens + (jetzt - b.last) * rate);
	b.last = jetzt;

	if (b.tokens < 1) {
		eimer.set(schluessel, b);
		return { erlaubt: false, retryAfter: Math.ceil((1 - b.tokens) / rate / 1000) };
	}
	b.tokens -= 1;
	eimer.set(schluessel, b);
	return { erlaubt: true, retryAfter: 0 };
}

/**
 * Nachsehen, ob gesperrt ist - ohne einen Versuch zu verbrauchen.
 *
 * Gebraucht dort, wo erst die ANTWORT sagt, ob es ein Versuch war: beim Abfragen
 * eines Kopplungsvorgangs zaehlt nur der Fehlgriff. Wer wartet, fragt denselben
 * Code immer wieder ab und darf davon nicht ausgebremst werden.
 */
export function istGesperrt(schluessel: string, opts: LimitOptions, jetzt = Date.now()): boolean {
	const b = eimer.get(schluessel);
	if (!b) return false;
	const rate = opts.perMinute / 60_000;
	return Math.min(opts.burst, b.tokens + (jetzt - b.last) * rate) < 1;
}

/**
 * Volle Eimer wegwerfen.
 *
 * Ohne das waechst die Karte mit jeder je gesehenen Adresse weiter. Ein voller
 * Eimer ist von "noch nie gesehen" nicht zu unterscheiden - er darf also weg.
 */
export function raeumeLimits(jetzt = Date.now()): void {
	for (const [k, b] of eimer) {
		// Nach einer Stunde Ruhe ist jeder Eimer wieder voll, egal wie klein die Rate.
		if (jetzt - b.last > 3600_000) eimer.delete(k);
	}
}

/** Nur fuer Tests: die Bremse in den Ausgangszustand bringen. */
export function resetLimitsForTests(): void {
	eimer.clear();
}

// ---------- Die Saetze ----------
//
// Grosszuegig genug, dass ein Mensch sie nie bemerkt, und eng genug, dass Raten
// keinen Sinn ergibt.

/**
 * Kopplung abfragen - gezaehlt werden nur FEHLGRIFFE.
 *
 * Das ist der Unterschied, an dem der erste Anlauf scheiterte: die Oberflaeche
 * fragt im Zwei-Sekunden-Takt nach, ob jemand bestaetigt hat. Das sind dreissig
 * Anfragen je Minute fuer einen voellig normalen Vorgang. Eine Bremse, die alle
 * zaehlt, haette nach vierzig Sekunden zugemacht - waehrend der Mensch noch den
 * Code abtippt.
 *
 * Wer wartet, fragt seinen EIGENEN Code ab und bekommt "noch nicht bestaetigt".
 * Wer raet, trifft nichts. Nur das zaehlt hier, und dafuer sind zehn Fehlgriffe
 * je Minute reichlich.
 */
export const LIMIT_PAIR_CLAIM: LimitOptions = { burst: 15, perMinute: 10 };
/** Kopplung beginnen: legt eine Zeile an, ist also teurer als eine Abfrage. */
export const LIMIT_PAIR_START: LimitOptions = { burst: 10, perMinute: 5 };
/** Anmelden und Registrieren. */
export const LIMIT_AUTH: LimitOptions = { burst: 15, perMinute: 10 };
