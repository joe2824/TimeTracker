import { defineConfig } from "vitest/config";

// Eigene, schlanke Vitest-Konfiguration (ohne SvelteKit-Plugin).
// Getestet wird reine Logik (time.ts, report.ts) im Node-Environment.
export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"]
	}
});
