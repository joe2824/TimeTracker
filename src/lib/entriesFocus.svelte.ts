import { fmtDate } from "./time";

/**
 * Kleiner UI-Navigations-Vermittler zwischen den Ansichten und der
 * Einträge-Liste. Wer einen Tag zeigen will, hinterlegt ihn hier; die
 * Einträge-Ansicht konsumiert den Wunsch (springt auf den Monat und scrollt den
 * Tag mittig).
 *
 * Gewünscht wird ein DATUM, nicht "heute": aus dem Tracking kommt der heutige
 * Tag, aus dem Arbeitszeit-Check ein beliebiger auffälliger Tag.
 *
 * Der Tabwechsel läuft über einen hinterlegten Rückruf und NICHT über einen
 * Effekt auf `pendingDate`. Das war er einmal, und es funktionierte nicht: den
 * Wunsch liest die Einträge-Ansicht und löscht ihn dabei sofort. Zwei
 * Verbraucher an einem Flag, von denen einer es abräumt, ist ein Rennen – lief
 * die Einträge-Ansicht zuerst, sah die Shell nur noch `null` und blieb, wo sie
 * war. Ein Klick auf einen auffälligen Tag im Bericht tat dann gar nichts.
 * Synchron im Klick-Handler gibt es diese Frage nicht.
 */
class EntriesFocus {
	/** Offener Wunsch als "YYYY-MM-DD", null = keiner. */
	pendingDate = $state<string | null>(null);

	/** Wie man zur Einträge-Ansicht kommt – hinterlegt von der App-Shell. */
	#showEntries: (() => void) | null = null;

	/**
	 * Die Shell hinterlegt hier, wie zur Einträge-Ansicht gewechselt wird.
	 * Nur eine Stelle kennt die Tabs, und das soll so bleiben.
	 */
	onShow(fn: () => void) {
		this.#showEntries = fn;
	}

	requestDate(date: string) {
		this.pendingDate = date;
		this.#showEntries?.();
	}

	requestToday() {
		this.requestDate(fmtDate(Date.now()));
	}
}

export const entriesFocus = new EntriesFocus();
