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

	const sinceTs = Number(url.searchParams.get("since") ?? 0);
	const knownSeq = currentSeq(locals.db, userId);
	// Schon etwas da: gar nicht erst warten. Ohne das verpasst ein Client jede
	// Aenderung, die zwischen seinem Abgleich und dieser Anfrage passiert ist.
	if (knownSeq > sinceTs) return json({ seq: knownSeq, changed: true });

	let logout: (() => void) | null = null;
	let clock: ReturnType<typeof setTimeout> | null = null;

	const full = await new Promise<boolean>((done) => {
		logout = subscribe(userId, () => done(false));
		if (!logout) return done(true);
		clock = setTimeout(() => done(false), SYNC_WAIT_MS);
		// Bricht der Client ab, wird hier aufgeraeumt statt bis zum Zeitablauf zu
		// warten - sonst haelt jeder Neustart einen Platz besetzt.
		request.signal.addEventListener("abort", () => done(false));
	});

	if (clock) clearTimeout(clock);
	(logout as (() => void) | null)?.();

	// Zu viele offene Verbindungen. Der Client faellt dann auf seinen langsamen
	// Takt zurueck, statt sofort wieder anzuklopfen.
	if (full) error(429, "Zu viele offene Verbindungen");

	const nowMs = currentSeq(locals.db, userId);
	return json({ seq: nowMs, changed: nowMs > sinceTs });
};
