import { fmtDate } from "./time";

/**
 * Kleiner UI-Navigations-Vermittler zwischen den Ansichten und der
 * Einträge-Liste. Wer einen Tag zeigen will, hinterlegt ihn hier; die
 * Einträge-Ansicht konsumiert den Wunsch (springt auf den Monat und scrollt den
 * Tag mittig).
 *
 * Gewünscht wird ein DATUM, nicht "heute": aus dem Tracking kommt der heutige
 * Tag, aus dem Arbeitszeit-Check ein beliebiger auffälliger Tag.
 */
class EntriesFocus {
	/** Offener Wunsch als "YYYY-MM-DD", null = keiner. */
	pendingDate = $state<string | null>(null);

	requestDate(date: string) {
		this.pendingDate = date;
	}

	requestToday() {
		this.requestDate(fmtDate(Date.now()));
	}
}

export const entriesFocus = new EntriesFocus();
