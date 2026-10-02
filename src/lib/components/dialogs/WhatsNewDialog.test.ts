// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("$lib/testing/fakeFs")).fakeFs);

const { CURRENT_RELEASE, whatsNew } = await import("$lib/release/whatsNew.svelte");
const { default: WhatsNewDialog } = await import("./WhatsNewDialog.svelte");

let dialog: ReturnType<typeof mount> | null = null;

const settle = async () => {
	for (let i = 0; i < 20; i++) {
		await new Promise((r) => setTimeout(r, 5));
		flushSync();
	}
};

afterEach(() => {
	whatsNew.isOpen = false;
	if (dialog) unmount(dialog);
	dialog = null;
	document.body.innerHTML = "";
});

describe("WhatsNewDialog", () => {
	it("zeigt den Gruss des Releases über der Zusammenfassung", async () => {
		dialog = mount(WhatsNewDialog, { target: document.body });
		// Wie in der App: der Dialog steht längst, wenn er aufgeht.
		await settle();
		whatsNew.open();
		await settle();

		expect(CURRENT_RELEASE.greeting).toBeTruthy();
		const text = document.body.textContent ?? "";
		expect(text).toContain(CURRENT_RELEASE.greeting);
		expect(text.indexOf(CURRENT_RELEASE.greeting!)).toBeLessThan(text.indexOf(CURRENT_RELEASE.summary));
	});
});
