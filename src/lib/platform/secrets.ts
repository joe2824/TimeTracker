// Geheimnisse ablegen - so gut, wie die Umgebung es hergibt.
//
// Auf dem Rechner uebernimmt das Betriebssystem (DPAPI, siehe
// src-tauri/src/secret.rs): der Wert ist an das Benutzerkonto gebunden, eine
// kopierte Datei nuetzt niemandem.
//
// Im Browser gibt es dafuer nichts. Kein Schutz ist dort besser als ein
// selbstgebauter mit dem Schluessel daneben - der schuetzt vor nichts und
// taeuscht Sicherheit vor. Deshalb sagt `protected` die Wahrheit, statt sie zu
// beschoenigen, und die Oberflaeche kann es dem Nutzer sagen.
import { isTauri } from "./env";

export interface ProtectedSecret {
	/** Der abzulegende Wert (base64). */
	data: string;
	/** Ob das Betriebssystem ihn wirklich geschuetzt hat. */
	protected: boolean;
}

export async function protectSecret(plain: string): Promise<ProtectedSecret> {
	if (!isTauri()) return { data: btoa(unescape(encodeURIComponent(plain))), protected: false };
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<ProtectedSecret>("protect_secret", { plain });
}

export async function unprotectSecret(data: string, wasProtected: boolean): Promise<string> {
	if (!isTauri()) {
		if (wasProtected) {
			// Eine Ablage, die auf dem Rechner geschuetzt wurde, laesst sich im
			// Browser nicht oeffnen. Das ist kein Fehler, sondern der Sinn der Sache.
			throw new Error("Dieser Wert ist an ein anderes Gerät gebunden");
		}
		return decodeURIComponent(escape(atob(data)));
	}
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<string>("unprotect_secret", { data, protected: wasProtected });
}
