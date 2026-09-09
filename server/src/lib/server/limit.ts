// Token-Eimer-Bremse für die Endpunkte, die ohne Anmeldung erreichbar sind.
//
// Im Prozessgedächtnis, nicht in der Datenbank - bei mehr als einer Instanz
// gehört das nach Redis.

/** Ein Eimer je Schlüssel: Rest und Zeitpunkt der letzten Füllung. */
interface Bucket {
	tokens: number;
	last: number;
}

const tokenBucket = new Map<string, Bucket>();

export interface LimitOptions {
	/** Wie viele Versuche in Folge erlaubt sind, wenn nichts nachfliesst. */
	burst: number;
	/** Wie viele Versuche je Minute nachfliessen. */
	perMinute: number;
}

/** Einen Versuch anmelden - erlaubt oder nicht, samt Wartezeit. */
export function takeAttempt(
	secretKey: string,
	opts: LimitOptions,
	nowMs = Date.now()
): { allowed: boolean; retryAfter: number } {
	const rate = opts.perMinute / 60_000;
	const present = tokenBucket.get(secretKey);
	const b = present ?? { tokens: opts.burst, last: nowMs };

	// Auffüllen für die verstrichene Zeit, aber nie über den Rand.
	b.tokens = Math.min(opts.burst, b.tokens + (nowMs - b.last) * rate);
	b.last = nowMs;

	if (b.tokens < 1) {
		tokenBucket.set(secretKey, b);
		return { allowed: false, retryAfter: Math.ceil((1 - b.tokens) / rate / 1000) };
	}
	b.tokens -= 1;
	tokenBucket.set(secretKey, b);
	return { allowed: true, retryAfter: 0 };
}

/** Nachsehen, ob gesperrt ist - ohne einen Versuch zu verbrauchen. */
export function isLocked(secretKey: string, opts: LimitOptions, nowMs = Date.now()): boolean {
	const b = tokenBucket.get(secretKey);
	if (!b) return false;
	const rate = opts.perMinute / 60_000;
	return Math.min(opts.burst, b.tokens + (nowMs - b.last) * rate) < 1;
}

/** Volle Eimer wegwerfen - sonst wächst die Karte mit jeder gesehenen Adresse. */
export function cleanupLimits(nowMs = Date.now()): void {
	for (const [k, b] of tokenBucket) {
		// Nach einer Stunde Ruhe ist jeder Eimer wieder voll, egal wie klein die Rate.
		if (nowMs - b.last > 3600_000) tokenBucket.delete(k);
	}
}

/** Reset all rate limit buckets (test helper). */
export function resetLimitsForTests(): void {
	tokenBucket.clear();
}



// ---------- Die Sätze ----------

/** Kopplung abfragen - gezählt werden nur FEHLGRIFFE (die Oberfläche pollt im 2-Sekunden-Takt). */
export const LIMIT_PAIR_CLAIM: LimitOptions = { burst: 15, perMinute: 10 };
/** Kopplung beginnen: legt eine Zeile an, ist also teurer als eine Abfrage. */
export const LIMIT_PAIR_START: LimitOptions = { burst: 10, perMinute: 5 };
/** Anmelden und Registrieren. */
export const LIMIT_AUTH: LimitOptions = { burst: 15, perMinute: 10 };
/**
 * Die Aufgabe für eine Anmeldung abholen.
 *
 * Eigener Eimer, weil die Oberfläche sie im Voraus holt: WebAuthn muss
 * unmittelbar auf die Berührung folgen, sonst lehnt der Browser ab. Dabei
 * fällt je Aufruf der Anmeldeseite eine Anfrage an - hinter einer gemeinsamen
 * Adresse wären mit dem strengen Satz sonst schon die Besucher am Zug, bevor
 * jemand geklickt hat. Geraten werden kann hier nichts: die Antwort ist eine
 * Zufallsaufgabe, geprüft wird erst beim Abschluss.
 */
export const LIMIT_AUTH_START: LimitOptions = { burst: 60, perMinute: 30 };
/** Wiederherstellung mit der Phrase - zwei Anfragen je Vorgang. */
export const LIMIT_RECOVER: LimitOptions = { burst: 12, perMinute: 6 };
/** Telemetrie-Ping (täglicher Heartbeat von Clients). */
export const LIMIT_TELEMETRY: LimitOptions = { burst: 30, perMinute: 15 };
/** Team beitreten: legt eine Zeile an, ein einmaliger Vorgang - kein Abfragen wie bei LIMIT_PAIR_CLAIM. */
export const LIMIT_TEAM_JOIN: LimitOptions = { burst: 10, perMinute: 5 };

