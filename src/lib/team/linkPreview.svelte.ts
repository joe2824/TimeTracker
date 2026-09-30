// Vorschau zu einem Team- oder Verwalter-Link: der Teamname, solange der Link
// gilt. Gemeinsam für den Beitritt (joinFlow) und die Verwalter-Einladung
// (adminJoinFlow).

export type LinkPreviewState = { teamName: string } | "loading" | "error";
type FetchPreview = (serverUrl: string, code: string) => Promise<{ teamName: string }>;

export class LinkPreview {
	state = $state<LinkPreviewState>("loading");
	/** Nummer der jüngsten Anfrage: eine ältere, spät antwortende darf nicht überschreiben. */
	#run = 0;
	#fetch: FetchPreview;

	constructor(fetchPreview: FetchPreview) {
		this.#fetch = fetchPreview;
	}

	/** Ob `run` (aus load()) noch die jüngste Anfrage ist. */
	isCurrent(run: number): boolean {
		return run === this.#run;
	}

	/** Vorschau für einen (neuen) Link laden. `run` gilt für isCurrent, `done` löst nie mit Fehler auf. */
	load(serverUrl: string, code: string): { run: number; done: Promise<void> } {
		const run = ++this.#run;
		this.state = "loading";
		const done = (async () => {
			try {
				const result = await this.#fetch(serverUrl, code);
				if (this.isCurrent(run)) this.state = result;
			} catch {
				if (this.isCurrent(run)) this.state = "error";
			}
		})();
		return { run, done };
	}
}
