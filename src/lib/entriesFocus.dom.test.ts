// @vitest-environment happy-dom
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
		// Die Eintraege-Ansicht ist ein KIND der Shell; ihr Effekt laeuft zuerst
		// und loescht den Wunsch, bevor die Shell ihn je zu sehen bekommt - deshalb
		// darf es kein Effekt sein.
		const s = klick("effect");
		expect(s.seen.date).toBe("2026-08-17"); // das Kind sieht ihn ...
		expect(s.tab).toBe("report"); // ... die Shell nie.
	});
});
