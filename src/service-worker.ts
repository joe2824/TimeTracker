/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

// Der Dienstmitarbeiter der PWA.

import { base, build, files, version } from "$service-worker";

const sw = self as unknown as ServiceWorkerGlobalScope;

/** Ein Zwischenspeicher je Fassung - damit ein Update den alten sauber ersetzt. */
const CACHE = `timetracker-${version}`;

/** Der Rahmen der Anwendung. */
const START = `${base}/`;

/** Was sich nie aendert: die Dateinamen tragen die Fassung. */
const IMMUTABLE = [...build, ...files];

/** Was vorgehalten wird: der Rahmen, das gebaute Programm, die mitgelieferten Dateien. */
const PRECACHE = [START, ...IMMUTABLE];

sw.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(PRECACHE))
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
			.then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
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

	event.respondWith(answer(req, url));
});

async function answer(req: Request, url: URL): Promise<Response> {
	const cache = await caches.open(CACHE);

	// Das gebaute Programm hat die Fassung im Namen und aendert sich nie: aus dem
	// Vorrat, ohne zu fragen. Der Rahmen gehoert ausdruecklich NICHT dazu - er
	// liegt unter einer festen Adresse und muss sich erneuern duerfen.
	if (IMMUTABLE.includes(url.pathname)) {
		const hit = await cache.match(url.pathname);
		if (hit) return hit;
	}

	try {
		const fresh = await fetch(req);
		// Nur echte Antworten aufheben. Eine Fehlerseite im Vorrat waere schlimmer
		// als gar keine.
		if (fresh.ok && fresh.type === "basic") cache.put(req, fresh.clone());
		return fresh;
	} catch {
		const hit = await cache.match(req);
		if (hit) return hit;
		// Ohne Netz und ohne Vorrat: die Startseite. Bei einer Seitenanwendung ist
		// das die Anwendung selbst, und die kann mit ihrem lokalen Bestand
		// weiterarbeiten.
		const start = await cache.match(START);
		if (start) return start;
		return new Response("Offline und nichts im Vorrat", { status: 503 });
	}
}
