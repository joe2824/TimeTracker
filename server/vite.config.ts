import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [sveltekit()],
	// better-sqlite3 ist eine native Erweiterung und darf nicht mitgebuendelt
	// werden - sonst sucht das Ergebnis zur Laufzeit eine .node-Datei, die es im
	// Buendel nicht gibt.
	ssr: { external: ["better-sqlite3"] }
});
