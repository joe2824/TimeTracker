import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	// Siehe svelte.config.js - vitest lädt die Kit-Aliase nicht selbst.
	resolve: {
		alias: { $shared: fileURLToPath(new URL("../shared", import.meta.url)) }
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		// Der gebaute Server lädt seine Routen erst beim ersten Zugriff nach, und
		// webauthn.test.ts importiert sein Modul mitten im Test. Auf einer
		// ausgelasteten Maschine dauert dieser eine Import länger als die 5 s, die
		// Vitest einem Test standardmässig lässt - dann kippt der jeweils ERSTE
		// Test einer Datei, ohne dass an ihm etwas falsch wäre.
		testTimeout: 30_000,
		hookTimeout: 30_000
	}
});
