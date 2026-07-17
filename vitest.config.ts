import { defineConfig } from "vitest/config";

// Eigene, schlanke Vitest-Konfiguration (ohne SvelteKit-Plugin).
// Getestet wird reine Logik im Node-Environment.
export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		// Zeitzone festnageln. Die Suite laeuft zwar in jeder Zone gruen, aber die
		// Tests zu Sommer-/Winterzeit (23- und 25-Stunden-Tage) pruefen nur dort
		// etwas, wo es ueberhaupt eine Umstellung gibt – auf einem UTC-CI-Runner
		// waeren sie stumm. Berlin ist ausserdem die Zone, in der das Programm laeuft.
		env: { TZ: "Europe/Berlin" }
	}
});
