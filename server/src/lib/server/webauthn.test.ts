// Was im Schluesselbund steht, wenn ein Passkey angelegt wird.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Das Modul mit dieser Umgebung frisch laden - RP_ID und RP_NAME kommen von dort. */
async function withEnv(env: Record<string, string>) {
	vi.resetModules();
	for (const [k, v] of Object.entries(env)) process.env[k] = v;
	return import("./webauthn");
}

const BASIS = { ORIGIN: "https://tracker.example.de", RP_ID: "tracker.example.de" };

// Vitest verwendet Worker-Prozesse fuer mehrere Test-Dateien wieder, `process.env`
// ueberlebt den Wechsel. Was hier gesetzt wird, muss also wieder weg.
const TOUCHED_ENV = ["ORIGIN", "RP_ID", "RP_NAME"] as const;
const envBefore = new Map(TOUCHED_ENV.map((k) => [k, process.env[k]] as const));

beforeEach(() => {
	delete process.env.RP_NAME;
});

afterAll(() => {
	for (const [k, v] of envBefore) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("passkeyLabel", () => {
	it("nennt Anwendung und Adresse, wenn das Konto keinen Namen hat", async () => {
		const { passkeyLabel } = await withEnv({ ...BASIS, RP_NAME: "TimeTracker" });
		// Genau der Fall aus der Desktop-Anwendung: displayName IST die Kennung.
		const id = "b5c67435-a3f3-4f59-93ea-ae4fb0af8a81";
		expect(passkeyLabel(id, id)).toBe("TimeTracker · tracker.example.de");
	});

	it("ebenso bei leerem Namen", async () => {
		const { passkeyLabel } = await withEnv({ ...BASIS, RP_NAME: "TimeTracker" });
		expect(passkeyLabel("   ", "abc")).toBe("TimeTracker · tracker.example.de");
	});

	it("nimmt einen echten Namen, wenn es einen gibt", async () => {
		const { passkeyLabel } = await withEnv({ ...BASIS, RP_NAME: "TimeTracker" });
		expect(passkeyLabel("Anna", "abc")).toBe("Anna · tracker.example.de");
	});

	it("zeigt nie eine nackte Kennung", async () => {
		const { passkeyLabel } = await withEnv({ ...BASIS, RP_NAME: "TimeTracker" });
		const id = "0f6c2f6e-1111-2222-3333-444455556666";
		expect(passkeyLabel(id, id)).not.toContain(id);
	});
});
