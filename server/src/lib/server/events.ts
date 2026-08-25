// Wecken, wenn sich etwas geaendert hat.
//
// Der Kanal traegt absichtlich keine Daten, sondern nur "es gibt Neues ab
// Nummer N". Wer geweckt wird, holt sich das Delta ueber den normalen Weg. Das
// haelt den Kanal winzig und erspart es, Chiffrate zweimal zu verschicken.
//
// Bewusst hinter einer schmalen Schnittstelle (publish/subscribe): solange genau
// eine Instanz laeuft, genuegt ein Ereignis-Verteiler im Prozess - null Bytes
// Zusatzaufwand, kein zweiter Container. Sobald eine zweite Instanz danebensteht,
// wird genau dieses Modul gegen Redis-Pub/Sub getauscht, ohne dass ein Endpunkt
// sich aendert.
import { MAX_STREAMS_PER_USER } from "./config";

export interface ChangeEvent {
	/** Bis zu welcher Nummer der Server jetzt Daten hat. */
	seq: number;
	/** Welches Geraet geschrieben hat - der Verursacher ignoriert seinen Weckruf. */
	deviceId: string | null;
}

type Listener = (e: ChangeEvent) => void;

const listeners = new Map<string, Set<Listener>>();

/**
 * Auf Aenderungen eines Kontos hoeren.
 *
 * @returns Funktion zum Abmelden, oder null, wenn das Konto zu viele offene
 *          Verbindungen hat. Die Grenze schuetzt vor einem Client mit einer
 *          kaputten Wiederverbindungs-Schleife, der sonst unbegrenzt viele
 *          offene Verbindungen anhaeuft.
 */
export function subscribe(userId: string, fn: Listener): (() => void) | null {
	let set = listeners.get(userId);
	if (!set) {
		set = new Set();
		listeners.set(userId, set);
	}
	if (set.size >= MAX_STREAMS_PER_USER) return null;
	set.add(fn);
	return () => {
		set!.delete(fn);
		// Leere Mengen wegraeumen: sonst waechst die Map mit jedem Konto, das je
		// verbunden war, und gibt den Platz nie wieder her.
		if (set!.size === 0) listeners.delete(userId);
	};
}

export function publish(userId: string, event: ChangeEvent): void {
	const set = listeners.get(userId);
	if (!set) return;
	// Ueber eine Kopie laufen: ein Zuhoerer, der sich beim Empfang abmeldet,
	// veraenderte sonst die Menge, ueber die gerade iteriert wird.
	for (const fn of [...set]) {
		try {
			fn(event);
		} catch {
			// Ein kaputter Zuhoerer darf die anderen nicht mitreissen.
		}
	}
}

/** Wie viele Verbindungen ein Konto offen hat - fuer Diagnose und Tests. */
export function listenerCount(userId: string): number {
	return listeners.get(userId)?.size ?? 0;
}

/** Nur fuer Tests. */
export function resetListeners(): void {
	listeners.clear();
}
