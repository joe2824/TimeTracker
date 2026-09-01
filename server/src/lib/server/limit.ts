// Token-Eimer-Bremse fuer die Endpunkte, die ohne Anmeldung erreichbar sind.
//
// Im Prozessgedaechtnis, nicht in der Datenbank - bei mehr als einer Instanz
// gehoert das nach Redis.

/** Ein Eimer je Schluessel: Rest und Zeitpunkt der letzten Fuellung. */
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

	// Auffuellen fuer die verstrichene Zeit, aber nie ueber den Rand.
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

export const isBlocked = isLocked;

/** Volle Eimer wegwerfen - sonst waechst die Karte mit jeder gesehenen Adresse. */
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

// Backward compatibility aliases
export const nimmVersuch = (k: string, opts: LimitOptions, now = Date.now()) => {
	const r = takeAttempt(k, opts, now);
	return { erlaubt: r.allowed, retryAfter: r.retryAfter };
};
export const istGesperrt = isLocked;
export const raeumeLimits = cleanupLimits;



// ---------- Die Saetze ----------

/** Kopplung abfragen - gezaehlt werden nur FEHLGRIFFE (die Oberflaeche pollt im 2-Sekunden-Takt). */
export const LIMIT_PAIR_CLAIM: LimitOptions = { burst: 15, perMinute: 10 };
/** Kopplung beginnen: legt eine Zeile an, ist also teurer als eine Abfrage. */
export const LIMIT_PAIR_START: LimitOptions = { burst: 10, perMinute: 5 };
/** Anmelden und Registrieren. */
export const LIMIT_AUTH: LimitOptions = { burst: 15, perMinute: 10 };
/** Wiederherstellung mit der Phrase - zwei Anfragen je Vorgang. */
export const LIMIT_RECOVER: LimitOptions = { burst: 12, perMinute: 6 };
/** Telemetrie-Ping (täglicher Heartbeat von Clients). */
export const LIMIT_TELEMETRY: LimitOptions = { burst: 30, perMinute: 15 };

