// Wecken, wenn sich etwas geändert hat.
import { MAX_STREAMS_PER_USER } from "./config";

export interface ChangeEvent {
	/** Bis zu welcher Nummer der Server jetzt Daten hat. */
	seq: number;
	/** Welches Gerät geschrieben hat - der Verursacher ignoriert seinen Weckruf. */
	deviceId: string | null;
}

type Listener = (e: ChangeEvent) => void;

const listeners = new Map<string, Set<Listener>>();

/**
 * Auf Änderungen eines Kontos hören.
 *
 * @returns Funktion zum Abmelden, oder null, wenn das Konto zu viele offene
 *          Verbindungen hat. Die Grenze schützt vor einem Client mit einer
 *          kaputten Wiederverbindungs-Schleife, der sonst unbegrenzt viele
 *          offene Verbindungen anhäuft.
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
		// Leere Mengen wegräumen: sonst wächst die Map mit jedem Konto, das je
		// verbunden war, und gibt den Platz nie wieder her.
		if (set!.size === 0) listeners.delete(userId);
	};
}

export function publish(userId: string, event: ChangeEvent): void {
	const set = listeners.get(userId);
	if (!set) return;
	// Über eine Kopie laufen: ein Zuhörer, der sich beim Empfang abmeldet,
	// veränderte sonst die Menge, über die gerade iteriert wird.
	for (const fn of [...set]) {
		try {
			fn(event);
		} catch {
			// Ein kaputter Zuhörer darf die anderen nicht mitreissen.
		}
	}
}

/** Wie viele Verbindungen ein Konto offen hat - für Diagnose und Tests. */
export function listenerCount(userId: string): number {
	return listeners.get(userId)?.size ?? 0;
}

/** Nur für Tests. */
export function resetListeners(): void {
	listeners.clear();
}
