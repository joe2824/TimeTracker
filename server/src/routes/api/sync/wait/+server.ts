// Der Weckruf für Clients ohne EventSource.
//
// Die Desktop-Anwendung weist sich mit einem Token aus, und EventSource kann
// keine Kopfzeilen setzen. Sie hängt hier stattdessen eine gewöhnliche Anfrage
// offen, bis sich etwas tut - dieselbe Zustellung, nur ohne Stream.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { subscribe } from "$lib/server/events";
import { currentSeq } from "$lib/server/sync";
import { SYNC_WAIT_MS } from "$lib/server/config";
import { requireUser } from "$lib/server/guards";

export const GET: RequestHandler = async ({ locals, url, request }) => {
	const userId = requireUser(locals);

	const sinceSeq = Number(url.searchParams.get("since") ?? 0);
	// Ohne die Prüfung wäre NaN nie kleiner als der Stand - die Anfrage hinge
	// jedes Mal die volle Zeit, obwohl längst etwas da ist.
	if (!Number.isFinite(sinceSeq) || sinceSeq < 0) error(400, "Ungültiger Stand");

	const knownSeq = currentSeq(locals.db, userId);
	// Schon etwas da: gar nicht erst warten. Ohne das verpasst ein Client jede
	// Änderung, die zwischen seinem Abgleich und dieser Anfrage passiert ist.
	if (knownSeq > sinceSeq) return json({ seq: knownSeq, changed: true });

	let unsubscribe: (() => void) | null = null;
	let clock: ReturnType<typeof setTimeout> | null = null;
	let onAbort: (() => void) | null = null;

	const full = await new Promise<boolean>((done) => {
		// Bricht der Client ab, wird hier aufgeräumt statt bis zum Zeitablauf zu
		// warten - sonst hält jeder Neustart einen Platz besetzt.
		if (request.signal.aborted) return done(false);
		unsubscribe = subscribe(userId, () => done(false));
		if (!unsubscribe) return done(true);
		clock = setTimeout(() => done(false), SYNC_WAIT_MS);
		onAbort = () => done(false);
		request.signal.addEventListener("abort", onAbort, { once: true });
	});

	if (clock) clearTimeout(clock);
	if (onAbort) request.signal.removeEventListener("abort", onAbort);
	(unsubscribe as (() => void) | null)?.();

	// Zu viele offene Verbindungen. Der Client fällt dann auf seinen langsamen
	// Takt zurück, statt sofort wieder anzuklopfen.
	if (full) error(429, "Zu viele offene Verbindungen");

	const seq = currentSeq(locals.db, userId);
	return json({ seq, changed: seq > sinceSeq });
};
