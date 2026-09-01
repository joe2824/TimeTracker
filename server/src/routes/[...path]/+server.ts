// Rueckfall fuer die Seitenanwendung.
import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ORIGIN } from "$lib/server/config";

/** Wo die gebaute PWA liegt - im Abbild neben dem Server. */
const CLIENT_DIR = process.env.CLIENT_DIR ?? "static";

/**
 * Die Shell heisst bewusst NICHT index.html: sonst liefert der statische
 * Dateiserver sie unter "/" aus, noch bevor dieser Handler drankommt - und dann
 * greift das Absolutmachen der og:-Adressen unten nie.
 */
const SHELL = "app-shell.html";

let cached: string | null = null;

/**
 * Vorschaubilder in Chat und sozialen Netzen brauchen vollstaendige Adressen;
 * ein relativer Pfad wird von vielen Diensten verworfen. Welche Adresse das ist,
 * steht erst beim Betreiber fest, nicht beim Bauen - deshalb hier zur Laufzeit.
 */
function withAbsoluteOgImage(html: string): string {
	return html.replace(
		/(<meta\s+property="og:image"\s+content=")([^"]*)(")/i,
		(match, before, url, after) =>
			/^https?:\/\//i.test(url) ? match : `${before}${new URL(url, ORIGIN).href}${after}`
	);
}

export const GET: RequestHandler = async ({ params }) => {
	// Die API antwortet selbst. Landet eine /api-Adresse hier, gibt es sie
	// wirklich nicht - und dann ist "nicht gefunden" die richtige Antwort, nicht
	// eine HTML-Seite, mit der ein Client nichts anfangen kann.
	if (params.path?.startsWith("api/")) error(404, "Unbekannter Endpunkt");

	try {
		// In Produktion im Speicher cachen, in Entwicklung frisch von Platte lesen,
		// damit ein Rebuild (npm run pwa:bundle) sofort ohne Server-Neustart greift.
		const raw =
			process.env.NODE_ENV === "production"
				? (cached ??= await readFile(join(CLIENT_DIR, SHELL), "utf-8"))
				: await readFile(join(CLIENT_DIR, SHELL), "utf-8");

		return new Response(withAbsoluteOgImage(raw), {
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
