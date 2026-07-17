import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
	// Svelte-Plugin, damit auch app.svelte.ts testbar ist: die Datei zieht ueber
	// svelte-sonner .svelte-Dateien herein, die Node sonst nicht laden kann. Dort
	// sitzt die riskanteste Logik der App (Mitternachts-Teilung, Rueckdatieren,
	// Konfliktregeln) – die war bis dahin komplett ungetestet.
	// `browser`-Condition: svelte-sonner liefert sonst die SSR-Fassung aus.
	plugins: [svelte({ hot: false })],
	resolve: { conditions: ["browser"] },
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		// Zeitzone standardmaessig festnageln: die Tests zu Sommer-/Winterzeit
		// (23- und 25-Stunden-Tage) pruefen nur dort etwas, wo es ueberhaupt eine
		// Umstellung gibt – auf einem UTC-CI-Runner waeren sie stumm. Berlin ist
		// ausserdem die Zone, in der das Programm laeuft.
		//
		// Ein gesetztes TZ gewinnt aber, sonst liesse sich die Suite nicht gegen
		// andere Zonen pruefen: ein fest verdrahtetes "Europe/Berlin" verschluckte
		// `TZ=Asia/Tokyo npx vitest run` stillschweigend und der Lauf sagte nichts
		// aus, obwohl er gruen meldet.
		env: { TZ: process.env.TZ ?? "Europe/Berlin" }
	}
});
