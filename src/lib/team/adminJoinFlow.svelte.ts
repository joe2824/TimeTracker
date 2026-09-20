// Der Ablauf "einen Verwalter-Link annehmen" für die Web-Route
// (routes/team/admin/[code]). Anders als beim einfachen Beitritt
// (joinFlow.svelte.ts) braucht das ein angemeldetes Konto - die Route läuft
// aber ohne den Start der Hauptseite und muss ihn deshalb selbst anstossen.
import { app } from "../app.svelte";
import { account } from "../sync/account.svelte";
import { previewAdminInvite } from "./api";
import { errorText, logError } from "../log";

export class AdminJoinFlow {
	preview = $state<{ teamName: string } | "loading" | "error">("loading");
	/** Ob feststeht, ob dieses Gerät ein Konto hat - vorher ist "nicht angemeldet" nur ein Vorurteil. */
	ready = $state(false);
	/** Die lokalen Daten oder das Konto ließen sich nicht starten - "angemeldet?" ist dann nicht zu beantworten. */
	startFailed = $state(false);
	joinedTeamName = $state<string | null>(null);
	joinError = $state<string | null>(null);
	busy = $state(false);

	/** Nummer der jüngsten Vorschau-Anfrage: eine ältere, spät antwortende darf nicht überschreiben. */
	#previewRun = 0;

	/** App und Konto starten, damit `account.linked` stimmt. */
	async start(): Promise<void> {
		try {
			if (await app.init()) await account.init();
			else this.startFailed = true;
		} catch (e) {
			logError("Verwalter-Link: Start fehlgeschlagen", e);
			this.startFailed = true;
		} finally {
			this.ready = true;
		}
	}

	/** Vorschau für einen (neuen) Link laden. */
	async loadPreview(serverUrl: string, code: string): Promise<void> {
		const run = ++this.#previewRun;
		this.preview = "loading";
		try {
			const result = await previewAdminInvite(serverUrl, code);
			if (run === this.#previewRun) this.preview = result;
		} catch {
			if (run === this.#previewRun) this.preview = "error";
		}
	}

	/** Den Link annehmen. Bei Erfolg steht der Teamname in `joinedTeamName`, sonst der Grund in `joinError`. */
	async accept(code: string): Promise<void> {
		this.busy = true;
		this.joinError = null;
		try {
			const team = await account.joinTeamAsAdmin(code);
			this.joinedTeamName = team.name;
		} catch (e) {
			this.joinError = errorText(e);
		} finally {
			this.busy = false;
		}
	}

	/** Beim Verlassen der Route: sonst laufen Abgleich und Uhr weiter und die nächste Seite startet ein zweites Paar. */
	dispose(): void {
		account.dispose();
		app.dispose();
	}
}
