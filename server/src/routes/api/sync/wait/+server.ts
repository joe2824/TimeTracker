// Der Weckruf fuer Clients ohne EventSource.
//
// Die Desktop-Anwendung weist sich mit einem Token aus, und EventSource kann
// keine Kopfzeilen setzen. Sie haengt hier stattdessen eine gewoehnliche Anfrage
// offen, bis sich etwas tut - dieselbe Zustellung, nur ohne Stream.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { subscribe } from "$lib/server/events";
import { currentSeq } from "$lib/server/sync";
import { SYNC_WAIT_MS } from "$lib/server/config";

export const GET: RequestHandler = async ({ locals, url, request }) => {
	const userId = locals.userId;
	if (!userId) error(401, "Nicht angemeldet");

	const seit = Number(url.searchParams.get("since") ?? 0);
	const stand = currentSeq(locals.db, userId);
	// Schon etwas da: gar nicht erst warten. Ohne das verpasst ein Client jede
	// Aenderung, die zwischen seinem Abgleich und dieser Anfrage passiert ist.
	if (stand > seit) return json({ seq: stand, changed: true });

	let abmelden: (() => void) | null = null;
	let uhr: ReturnType<typeof setTimeout> | null = null;

	const voll = await new Promise<boolean>((fertig) => {
		abmelden = subscribe(userId, () => fertig(false));
		if (!abmelden) return fertig(true);
		uhr = setTimeout(() => fertig(false), SYNC_WAIT_MS);
		// Bricht der Client ab, wird hier aufgeraeumt statt bis zum Zeitablauf zu
		// warten - sonst haelt jeder Neustart einen Platz besetzt.
		request.signal.addEventListener("abort", () => fertig(false));
	});

	if (uhr) clearTimeout(uhr);
	(abmelden as (() => void) | null)?.();

	// Zu viele offene Verbindungen. Der Client faellt dann auf seinen langsamen
	// Takt zurueck, statt sofort wieder anzuklopfen.
	if (voll) error(429, "Zu viele offene Verbindungen");

	const jetzt = currentSeq(locals.db, userId);
	return json({ seq: jetzt, changed: jetzt > seit });
};
