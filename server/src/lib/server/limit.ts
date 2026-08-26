// Token-Eimer-Bremse fuer die Endpunkte, die ohne Anmeldung erreichbar sind.
//
// Im Prozessgedaechtnis, nicht in der Datenbank - bei mehr als einer Instanz
// gehoert das nach Redis.

/** Ein Eimer je Schluessel: Rest und Zeitpunkt der letzten Fuellung. */
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

/** Einen Versuch anmelden - erlaubt oder nicht, samt Wartezeit. */
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

/** Nachsehen, ob gesperrt ist - ohne einen Versuch zu verbrauchen. */
export function istGesperrt(schluessel: string, opts: LimitOptions, jetzt = Date.now()): boolean {
	const b = eimer.get(schluessel);
	if (!b) return false;
	const rate = opts.perMinute / 60_000;
	return Math.min(opts.burst, b.tokens + (jetzt - b.last) * rate) < 1;
}

/** Volle Eimer wegwerfen - sonst waechst die Karte mit jeder gesehenen Adresse. */
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

/** Kopplung abfragen - gezaehlt werden nur FEHLGRIFFE (die Oberflaeche pollt im 2-Sekunden-Takt). */
export const LIMIT_PAIR_CLAIM: LimitOptions = { burst: 15, perMinute: 10 };
/** Kopplung beginnen: legt eine Zeile an, ist also teurer als eine Abfrage. */
export const LIMIT_PAIR_START: LimitOptions = { burst: 10, perMinute: 5 };
/** Anmelden und Registrieren. */
export const LIMIT_AUTH: LimitOptions = { burst: 15, perMinute: 10 };
/** Wiederherstellung mit der Phrase - zwei Anfragen je Vorgang. */
export const LIMIT_RECOVER: LimitOptions = { burst: 12, perMinute: 6 };
