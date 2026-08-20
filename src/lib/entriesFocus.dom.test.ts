// @vitest-environment happy-dom
//
// Der Weg "Klick auf einen auffaelligen Tag -> Eintraege" haengt an zwei
// Verbrauchern desselben Wunsches: die App-Shell wechselt den Tab, die
// Eintraege-Ansicht liest den Wunsch und raeumt ihn dabei AB.
//
// Ob das gutgeht, entscheidet die Reihenfolge, in der Svelte die Effekte
// abarbeitet – und die laesst sich nicht erdenken. Ein erster Versuch, das mit
// nachgebauten Effekten in einem `$effect.root` zu pruefen, log sogar: unter
// `environment: "node"` uebersetzt Vitest im SSR-Modus, dort ist `$effect` ein
// No-op, und beide Effekte liefen null Mal. Deshalb hier echte, ineinander
// verschachtelte Komponenten in einem echten DOM.
import { describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { entriesFocus } from "./entriesFocus.svelte";
import Shell from "./testing/focus/Shell.svelte";

/** Einen Klick auf einen Tag durchspielen und zurueckgeben, was passiert ist. */
function klick(wiring: "effect" | "callback") {
	entriesFocus.pendingDate = null;
	entriesFocus.onShow(() => {});
	const state = { tab: "report", seen: { date: null as string | null } };
	const target = document.createElement("div");
	document.body.appendChild(target);
	const app = mount(Shell, { target, props: { wiring, state } });
	flushSync();

	entriesFocus.requestDate("2026-08-17");
	flushSync();

	unmount(app);
	target.remove();
	entriesFocus.onShow(() => {});
	return state;
}

describe("Wunsch aus dem Bericht in die Eintraege", () => {
	it("wechselt den Tab und uebergibt den Tag", () => {
		const s = klick("callback");
		expect(s.tab).toBe("entries");
		expect(s.seen.date).toBe("2026-08-17");
	});

	it("belegt, warum es kein Effekt sein darf: Kind-Effekte laufen zuerst", () => {
		// Genau der Fehler, der in der App auftrat – ein Klick tat gar nichts.
		// Die Eintraege-Ansicht ist ein KIND der Shell; ihr Effekt laeuft zuerst
		// und loescht den Wunsch, bevor die Shell ihn je zu sehen bekommt.
		//
		// Der Test haelt das absichtlich als Fehlverhalten fest: wer den
		// Tabwechsel wieder ueber einen Effekt verdrahtet, muss hier
		// vorbeikommen und es bewusst tun.
		const s = klick("effect");
		expect(s.seen.date).toBe("2026-08-17"); // das Kind sieht ihn ...
		expect(s.tab).toBe("report"); // ... die Shell nie.
	});
});
