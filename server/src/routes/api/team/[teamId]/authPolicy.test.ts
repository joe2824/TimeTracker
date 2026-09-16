// Reiner Text-Scan ueber die Routen-Dateien, kein Ausfuehren der Handler: $lib
// loest vitest hier nicht auf (siehe server/vitest.config.ts), ein echter
// Import der Routen scheitert deshalb. Bewacht stattdessen, dass jede Methode
// jeder Team-Route den richtigen Zugriffs-Check nutzt - requireOwnTeam fuer
// Chef-only, requireTeamAccess fuer Chef+Verwalter (siehe der Kommentar dazu
// in teams.ts). Eine neue oder kopierte Route mit dem falschen Check faellt
// hier auf, statt erst im Betrieb ueberraschend zu wenig oder zu viel
// preiszugeben.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type AuthCheck = "requireOwnTeam" | "requireTeamAccess";

/** Datei relativ zu diesem Test, HTTP-Methode -> erwarteter Zugriffs-Check. */
const EXPECTED: Record<string, Partial<Record<Method, AuthCheck>>> = {
	"+server.ts": { DELETE: "requireOwnTeam" },
	"reports/+server.ts": { GET: "requireTeamAccess", POST: "requireTeamAccess", DELETE: "requireTeamAccess" },
	"invite/+server.ts": { GET: "requireTeamAccess", POST: "requireTeamAccess" },
	"admins/+server.ts": { GET: "requireTeamAccess", DELETE: "requireOwnTeam" },
	"admin-invite/+server.ts": { GET: "requireOwnTeam", POST: "requireOwnTeam" },
	"activities/+server.ts": { GET: "requireTeamAccess", PUT: "requireTeamAccess" },
	"owner/+server.ts": { POST: "requireOwnTeam" },
	"members/+server.ts": { GET: "requireTeamAccess", DELETE: "requireTeamAccess" }
};

const ROOT = fileURLToPath(new URL(".", import.meta.url));

/** Alle "+server.ts" unter ROOT, als Pfad relativ zu ROOT (mit "/" getrennt). */
function findRouteFiles(): string[] {
	return readdirSync(ROOT, { recursive: true })
		.map(String)
		.filter((f) => f.endsWith("+server.ts") && f !== "authPolicy.test.ts")
		.map((f) => f.split("\\").join("/"));
}

/** Den Zugriffs-Check, den ein Handler als erstes aufruft - oder null, wenn keiner der beiden vorkommt. */
function authCheckOf(source: string, method: Method): AuthCheck | null {
	const start = source.indexOf(`export const ${method}:`);
	if (start === -1) return null;
	const next = source.indexOf("\nexport const ", start + 1);
	const body = source.slice(start, next === -1 ? source.length : next);
	if (/\brequireOwnTeam\(/.test(body)) return "requireOwnTeam";
	if (/\brequireTeamAccess\(/.test(body)) return "requireTeamAccess";
	return null;
}

describe("Zugriffs-Policy der Team-Routen", () => {
	it("jede Routen-Datei unter [teamId]/ ist in der Tabelle erfasst - keine neue Route bleibt ungeprueft", () => {
		expect(findRouteFiles().sort()).toEqual(Object.keys(EXPECTED).sort());
	});

	for (const [file, methods] of Object.entries(EXPECTED)) {
		const source = readFileSync(join(ROOT, file), "utf-8");
		const actualMethods = [...source.matchAll(/export const (GET|POST|PUT|PATCH|DELETE):/g)].map((m) => m[1]);

		it(`${file}: jede exportierte Methode ist in der Tabelle erfasst`, () => {
			expect(new Set(actualMethods)).toEqual(new Set(Object.keys(methods)));
		});

		for (const [method, expected] of Object.entries(methods)) {
			it(`${file} ${method} nutzt ${expected}`, () => {
				expect(authCheckOf(source, method as Method)).toBe(expected);
			});
		}
	}
});
