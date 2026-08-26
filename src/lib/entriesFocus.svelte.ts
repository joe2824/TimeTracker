import { fmtDate } from "./time";

/**
 * Kleiner UI-Navigations-Vermittler zwischen den Ansichten und der
 * Einträge-Liste. Wer einen Tag zeigen will, hinterlegt ihn hier; die
 * Einträge-Ansicht konsumiert den Wunsch (springt auf den Monat und scrollt den
 * Tag mittig).
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
