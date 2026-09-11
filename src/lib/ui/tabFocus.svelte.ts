/**
 * Vermittler für Tab-Sprünge aus tief verschachtelten Komponenten heraus -
 * wie entriesFocus, nur für die Haupt-Tabs der App-Shell statt für einen Tag
 * in der Einträge-Ansicht. Reicht ein Sprung nach „Einstellungen" bis zu
 * einem bestimmten Unterreiter, steht der hier als Zielwunsch, den
 * SettingsPanel konsumiert.
 */
class TabFocus {
	/** Ziel-Unterreiter in den Einstellungen, null = keiner offen. */
	pendingSettingsTab = $state<string | null>(null);

	/** Wie man zu einem Haupt-Tab wechselt – hinterlegt von der App-Shell. */
	#navigate: ((tab: string) => void) | null = null;

	/**
	 * Die Shell hinterlegt hier, wie der Haupt-Tab gewechselt wird. Nur eine
	 * Stelle kennt die Tabs, und das soll so bleiben.
	 */
	onNavigate(fn: (tab: string) => void) {
		this.#navigate = fn;
	}

	request(tab: string) {
		this.#navigate?.(tab);
	}

	requestSettings(settingsTab: string) {
		this.pendingSettingsTab = settingsTab;
		this.request("settings");
	}
}

export const tabFocus = new TabFocus();
