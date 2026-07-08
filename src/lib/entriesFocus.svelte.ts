/**
 * Kleiner UI-Navigations-Vermittler zwischen Tracking- und Einträge-Ansicht.
 * Tracking setzt den Wunsch „heutigen Tag zeigen", die Einträge-Ansicht
 * konsumiert ihn (springt auf den aktuellen Monat und scrollt den Tag mittig).
 */
class EntriesFocus {
	/** Offener Wunsch: zur Einträge-Ansicht wechseln und den heutigen Tag mittig zeigen. */
	pendingToday = $state(false);

	requestToday() {
		this.pendingToday = true;
	}
}

export const entriesFocus = new EntriesFocus();
