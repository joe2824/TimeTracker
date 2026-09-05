// Der Ablauf "dieses Gerät hängt sich an ein Konto": einen Kopplungscode holen,
// ihn zeigen und alle zwei Sekunden nachsehen, ob drüben jemand bestätigt hat.
// Steht im Einrichtungs-Assistenten und in den Kontoeinstellungen.
import { account } from "./sync/account.svelte";
import { capabilities } from "./platform/env";

/** Abstand zwischen zwei Nachfragen beim Server. */
const POLL_MS = 2000;

/** Ein Vorschlag für den Gerätenamen, den die Geräteliste später zeigt. */
export function suggestDeviceName(): string {
	const platform = navigator.platform || "Gerät";
	return capabilities.tray ? `Rechner (${platform})` : `Browser (${platform})`;
}

export class PairingFlow {
	/** Der Code zum Eintippen auf dem anderen Gerät. Leer: es läuft nichts. */
	code = $state("");
	/** Ob gerade auf die Bestätigung gewartet wird. */
	waiting = $state(false);

	#timer: ReturnType<typeof setInterval> | null = null;
	#done: () => void;
	#failed: (e: unknown) => void;

	constructor(handlers: { done: () => void; failed: (e: unknown) => void }) {
		this.#done = handlers.done;
		this.#failed = handlers.failed;
	}

	/**
	 * Den Code holen und ab da nachsehen.
	 *
	 * Wirft, wenn schon das Holen scheitert - dann steht der Mensch noch am Knopf,
	 * und der Aufrufer meldet es dort. Was danach schiefgeht, kommt über
	 * `failed`: da schaut niemand mehr auf den Knopf.
	 */
	async start(serverUrl: string): Promise<void> {
		// Ein zweiter Anlauf, waehrend der erste noch nachsieht: ohne das liefe
		// dessen Timer weiter, und niemand haette ihn mehr in der Hand.
		this.stop();
		this.code = await account.startPairing(serverUrl, suggestDeviceName());
		this.waiting = true;
		this.#timer = setInterval(() => void this.#check(), POLL_MS);
	}

	async #check(): Promise<void> {
		try {
			if (!(await account.checkPairing())) return;
			this.cancel();
			this.#done();
		} catch (e) {
			this.cancel();
			this.#failed(e);
		}
	}

	/** Abbrechen: der Vorgang gilt danach auch auf diesem Gerät nicht mehr. */
	cancel(): void {
		this.stop();
		this.waiting = false;
		this.code = "";
		account.cancelPairing();
	}

	/**
	 * Nur das Nachsehen einstellen - für `onDestroy`. Ohne das läuft der Timer
	 * weiter, wenn die Ansicht verschwindet, während die Kopplung offen ist.
	 */
	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
	}
}
