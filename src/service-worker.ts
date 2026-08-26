/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

// Der Dienstmitarbeiter der PWA.
//
// Seine Aufgabe ist eng: die Anwendung selbst offline verfuegbar halten. Die
// DATEN gehen ihn nichts an - die liegen in IndexedDB und werden von der
// Abgleich-Maschine gepflegt. Ein Zwischenspeicher fuer API-Antworten waere hier
// falsch: er zeigte alte Staende, die nach einem Abgleich schon nicht mehr
// stimmen.
//
// Wichtig fuer die Erwartung: die App muss NICHT geoeffnet sein, damit die Zeit
// weiterlaeuft. Ein laufender Timer ist ein Datensatz mit einem Startzeitpunkt;
// die Dauer wird gerechnet, wenn jemand hinsieht.

import { base, build, files, version } from "$service-worker";

const sw = self as unknown as ServiceWorkerGlobalScope;

/** Ein Zwischenspeicher je Fassung - damit ein Update den alten sauber ersetzt. */
const CACHE = `timetracker-${version}`;

/**
 * Der Rahmen der Anwendung.
 *
 * Muss ausdruecklich dabeistehen: `build` und `files` enthalten das gebaute
 * Programm und den statischen Ordner - die index.html, die adapter-static als
 * Rueckfall ausliefert, steht in KEINEM von beiden. Ohne sie fand ein kalter
 * Start ohne Netz nichts im Vorrat und endete beim 503; erst nachdem einmal
 * online geladen wurde, lag sie durch den Fetch-Haken zufaellig im Speicher.
 *
 * Mit `base` davor wie alles andere im Vorrat: heute ist das leer, aber ein fest
 * verdrahtetes "/" waere genau die Zeile, die bei einer Unterverzeichnis-
 * Installation als einzige daneben laege.
 */
const START = `${base}/`;

/** Was sich nie aendert: die Dateinamen tragen die Fassung. */
const UNVERAENDERLICH = [...build, ...files];

/** Was vorgehalten wird: der Rahmen, das gebaute Programm, die mitgelieferten Dateien. */
const VORRAT = [START, ...UNVERAENDERLICH];

sw.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(VORRAT))
			// Sofort uebernehmen: sonst bliebe nach einem Update die alte Fassung
			// aktiv, bis alle Fenster geschlossen wurden - was auf dem Handy selten
			// passiert.
			.then(() => sw.skipWaiting())
	);
});

sw.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((namen) => Promise.all(namen.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
			.then(() => sw.clients.claim())
	);
});

sw.addEventListener("fetch", (event) => {
	const req = event.request;
	// Nur einfache Abrufe der eigenen Herkunft. Alles andere - vor allem die API -
	// geht unangetastet ins Netz.
	if (req.method !== "GET") return;
	const url = new URL(req.url);
	if (url.origin !== location.origin) return;
	if (url.pathname.startsWith("/api/")) return;

	event.respondWith(antwort(req, url));
});

async function antwort(req: Request, url: URL): Promise<Response> {
	const cache = await caches.open(CACHE);

	// Das gebaute Programm hat die Fassung im Namen und aendert sich nie: aus dem
	// Vorrat, ohne zu fragen. Der Rahmen gehoert ausdruecklich NICHT dazu - er
	// liegt unter einer festen Adresse und muss sich erneuern duerfen.
	if (UNVERAENDERLICH.includes(url.pathname)) {
		const treffer = await cache.match(url.pathname);
		if (treffer) return treffer;
	}

	try {
		const frisch = await fetch(req);
		// Nur echte Antworten aufheben. Eine Fehlerseite im Vorrat waere schlimmer
		// als gar keine.
		if (frisch.ok && frisch.type === "basic") cache.put(req, frisch.clone());
		return frisch;
	} catch {
		const treffer = await cache.match(req);
		if (treffer) return treffer;
		// Ohne Netz und ohne Vorrat: die Startseite. Bei einer Seitenanwendung ist
		// das die Anwendung selbst, und die kann mit ihrem lokalen Bestand
		// weiterarbeiten.
		const start = await cache.match(START);
		if (start) return start;
		return new Response("Offline und nichts im Vorrat", { status: 503 });
	}
}
