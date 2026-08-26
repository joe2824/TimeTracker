// Welche Adressen einen Passkey tragen koennen.
//
// Die Regel kommt nicht von uns, sondern vom Browser: er laesst einen Passkey
// nur zu, wenn die Adresse unter der RP-Kennung liegt - gleiche Domain oder eine
// Unterdomain davon. Mehrere Adressen sind also moeglich, aber nicht beliebige.
//
// Geprueft wird hier die Auswahl, die config.ts trifft. Sie zu treffen ist
// billig; sie NICHT zu treffen kostet jemanden einen Nachmittag, weil der
// Browser eine Meldung zeigt, die niemand mit dieser Einstellung in Verbindung
// bringt.
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Die Einstellungen mit dieser Umgebung frisch laden. */
async function mitUmgebung(env: Record<string, string>) {
	vi.resetModules();
	for (const [k, v] of Object.entries(env)) process.env[k] = v;
	return import("./config");
}

beforeEach(() => {
	delete process.env.ALLOWED_ORIGINS;
});

describe("Adressen und Passkey-Kennung", () => {
	it("nimmt die Kennung selbst", async () => {
		const c = await mitUmgebung({
			ORIGIN: "https://example.de",
			RP_ID: "example.de"
		});
		expect(c.WEBAUTHN_ORIGINS).toContain("https://example.de");
		expect(c.ORIGINS_OHNE_PASSKEY).toHaveLength(0);
	});

	it("nimmt mehrere Unterdomains derselben Kennung", async () => {
		// Der Fall, um den es geht: ein Passkey, der auf beiden Adressen gilt.
		const c = await mitUmgebung({
			ORIGIN: "https://tracker.example.de",
			RP_ID: "example.de",
			ALLOWED_ORIGINS: "https://app.example.de,https://zeit.example.de"
		});
		expect(c.WEBAUTHN_ORIGINS).toEqual(
			expect.arrayContaining([
				"https://tracker.example.de",
				"https://app.example.de",
				"https://zeit.example.de"
			])
		);
		expect(c.ORIGINS_OHNE_PASSKEY).toHaveLength(0);
	});

	it("sortiert eine fremde Domain aus", async () => {
		const c = await mitUmgebung({
			ORIGIN: "https://tracker.example.de",
			RP_ID: "example.de",
			ALLOWED_ORIGINS: "https://tracker.example.com"
		});
		expect(c.WEBAUTHN_ORIGINS).not.toContain("https://tracker.example.com");
		expect(c.ORIGINS_OHNE_PASSKEY).toContain("https://tracker.example.com");
	});

	it("sortiert localhost neben einer echten Domain aus", async () => {
		// Der haeufigste Irrtum: beides gleichzeitig zu wollen. Es geht nicht -
		// localhost und example.de haben keine gemeinsame Domain.
		const c = await mitUmgebung({
			ORIGIN: "https://tracker.example.de",
			RP_ID: "example.de",
			ALLOWED_ORIGINS: "http://localhost:3000"
		});
		expect(c.WEBAUTHN_ORIGINS).not.toContain("http://localhost:3000");
		expect(c.ORIGINS_OHNE_PASSKEY).toContain("http://localhost:3000");
	});

	it("laesst sich nicht von einer aehnlich klingenden Domain taeuschen", async () => {
		// "boesexample.de" endet auf "example.de", ist aber eine ganz andere
		// Domain. Ohne den Punkt in der Pruefung waere das ein Einfallstor.
		const c = await mitUmgebung({
			ORIGIN: "https://tracker.example.de",
			RP_ID: "example.de",
			ALLOWED_ORIGINS: "https://boesexample.de"
		});
		expect(c.WEBAUTHN_ORIGINS).not.toContain("https://boesexample.de");
	});

	it("kommt mit einer unsinnigen Adresse zurecht", async () => {
		const c = await mitUmgebung({
			ORIGIN: "https://example.de",
			RP_ID: "example.de",
			ALLOWED_ORIGINS: "das ist keine Adresse"
		});
		expect(c.WEBAUTHN_ORIGINS).not.toContain("das ist keine Adresse");
		expect(c.WEBAUTHN_ORIGINS).toContain("https://example.de");
	});

	it("localhost mit Port traegt Passkeys, wenn die Kennung localhost ist", async () => {
		// Fuer die Entwicklung: der Browser erlaubt dort ausnahmsweise auch HTTP.
		const c = await mitUmgebung({
			ORIGIN: "http://localhost:3000",
			RP_ID: "localhost"
		});
		expect(c.WEBAUTHN_ORIGINS).toContain("http://localhost:3000");
	});
});

describe("Was ueberhaupt eine Passkey-Kennung sein kann", () => {
	it("nimmt eine Domain", async () => {
		const { istGueltigeKennung } = await mitUmgebung({
			ORIGIN: "https://example.de",
			RP_ID: "example.de"
		});
		expect(istGueltigeKennung("example.de")).toBe(true);
		expect(istGueltigeKennung("tracker.example.de")).toBe(true);
	});

	it("nimmt localhost", async () => {
		const { istGueltigeKennung } = await mitUmgebung({
			ORIGIN: "http://localhost:3000",
			RP_ID: "localhost"
		});
		// Die eine Ausnahme, die auch ohne HTTPS geht - fuer die Entwicklung
		// ausdruecklich vorgesehen.
		expect(istGueltigeKennung("localhost")).toBe(true);
	});

	it("nimmt KEINE IP-Adresse", async () => {
		// Genau der Fall, den der Browser mit "127.0.0.1 is an invalid domain"
		// abweist. Das ist keine Einstellung, sondern steht so in der Norm - und
		// deshalb soll es hier auffallen und nicht erst dort.
		const { istGueltigeKennung } = await mitUmgebung({
			ORIGIN: "http://localhost:3000",
			RP_ID: "localhost"
		});
		expect(istGueltigeKennung("127.0.0.1")).toBe(false);
		expect(istGueltigeKennung("192.168.1.50")).toBe(false);
		expect(istGueltigeKennung("::1")).toBe(false);
		expect(istGueltigeKennung("fe80::1")).toBe(false);
	});

	it("nimmt keinen blossen Rechnernamen ohne Punkt", async () => {
		const { istGueltigeKennung } = await mitUmgebung({
			ORIGIN: "http://localhost:3000",
			RP_ID: "localhost"
		});
		// "heimserver" ist keine Domain. Auch das weist der Browser ab.
		expect(istGueltigeKennung("heimserver")).toBe(false);
	});

	it("laesst bei einer IP als Kennung gar keine Adresse zu", async () => {
		// Nicht "ein bisschen kaputt", sondern eindeutig: es gibt dann keine
		// Adresse, auf der ein Passkey gilt. Der Server sagt das beim Start.
		const c = await mitUmgebung({
			ORIGIN: "http://127.0.0.1:3000",
			RP_ID: "127.0.0.1"
		});
		expect(c.WEBAUTHN_ORIGINS).toHaveLength(0);
	});
});
