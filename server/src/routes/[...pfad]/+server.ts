// Rueckfall fuer die Seitenanwendung.
import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Wo die gebaute PWA liegt - im Abbild neben dem Server. */
const CLIENT_DIR = process.env.CLIENT_DIR ?? "static";

let cached: string | null = null;

export const GET: RequestHandler = async ({ params }) => {
	// Die API antwortet selbst. Landet eine /api-Adresse hier, gibt es sie
	// wirklich nicht - und dann ist "nicht gefunden" die richtige Antwort, nicht
	// eine HTML-Seite, mit der ein Client nichts anfangen kann.
	if (params.pfad?.startsWith("api/")) error(404, "Unbekannter Endpunkt");

	try {
		// In Produktion im Speicher cachen, in Entwicklung frisch von Platte lesen,
		// damit ein Rebuild (npm run pwa:bundle) sofort ohne Server-Neustart greift.
		const html =
			process.env.NODE_ENV === "production"
				? (cached ??= await readFile(join(CLIENT_DIR, "index.html"), "utf-8"))
				: await readFile(join(CLIENT_DIR, "index.html"), "utf-8");

		return new Response(html, {
			headers: {
				"content-type": "text/html; charset=utf-8",
				// Nicht zwischenspeichern: die Datei verweist auf Bau-Dateien mit
				// Fassungsnummer im Namen.
				"cache-control": "no-cache"
			}
		});
	} catch {
		error(503, "Die Anwendung ist in diesem Abbild nicht enthalten");
	}
};
