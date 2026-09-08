import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

export default defineConfig({
	// Svelte-Plugin, damit auch app.svelte.ts testbar ist: die Datei zieht über
	// svelte-sonner .svelte-Dateien herein, die Node sonst nicht laden kann. Dort
	// sitzt die riskanteste Logik der App (Mitternachts-Teilung, Rückdatieren,
	// Konfliktregeln) – die war bis dahin komplett ungetestet.
	// `browser`-Condition: svelte-sonner liefert sonst die SSR-Fassung aus.
	plugins: [svelte({ hot: false })],
	// $shared zeigt auf das Verzeichnis, das Client und Server teilen. Der
	// Alias steht in svelte.config.js für den Build - vitest lädt die nicht.
	resolve: {
		conditions: ["browser"],
		alias: { $shared: fileURLToPath(new URL("./shared", import.meta.url)) }
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		// Zeitzone standardmässig festnageln: die Tests zu Sommer-/Winterzeit
		// (23- und 25-Stunden-Tage) prüfen nur dort etwas, wo es überhaupt eine
		// Umstellung gibt – auf einem UTC-CI-Runner wären sie stumm. Berlin ist
		// ausserdem die Zone, in der das Programm läuft.
		env: { TZ: process.env.TZ ?? "Europe/Berlin" },
		// Die Kontozeitzone hängt NICHT an der Gerätezone: sie wird hier fest
		// gesetzt. Damit prüft `TZ=Pacific/Auckland npx vitest run` die Zusage,
		// dass zwei Geräte in verschiedenen Zonen denselben Arbeitstag sehen –
		// die ganze Suite muss dort unverändert grün sein.
		setupFiles: ["src/lib/testing/pinZone.ts"]
	}
});
