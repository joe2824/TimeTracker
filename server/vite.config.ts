import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

let version = "0.9.0-beta.7";
try {
	const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));
	if (pkg.version) version = pkg.version;
} catch {}

export default defineConfig({
	plugins: [sveltekit()],
	define: {
		__SERVER_VERSION__: JSON.stringify(version)
	},
	// better-sqlite3 ist eine native Erweiterung und darf nicht mitgebuendelt
	// werden - sonst sucht das Ergebnis zur Laufzeit eine .node-Datei, die es im
	// Buendel nicht gibt.
	ssr: { external: ["better-sqlite3"] }
});
