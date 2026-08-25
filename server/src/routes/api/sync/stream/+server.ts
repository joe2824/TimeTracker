// Der Weckruf-Kanal.
//
// Server-Sent Events statt WebSocket: es geht nur in eine Richtung, jeder
// Reverse-Proxy kann damit umgehen, und der Wiederverbindungs-Versuch steckt
// schon im Browser. Ein WebSocket waere hier Aufwand ohne Gewinn.
//
// Der Kanal traegt keine Daten, nur "es gibt Neues ab Nummer N". Wer das hoert,
// holt sich das Delta ueber /api/sync. Damit reisen Chiffrate genau einmal.
import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { subscribe } from "$lib/server/events";
import { currentSeq } from "$lib/server/sync";

/**
 * Alle 30 Sekunden ein Lebenszeichen.
 *
 * Nicht fuer den Client, sondern gegen die Zeitgeber dazwischen: Reverse-Proxies
 * und Mobilfunknetze schliessen eine Verbindung, auf der lange nichts passiert.
 * Ein Doppelpunkt ist ein SSE-Kommentar - zwei Bytes, die niemand auswertet.
 */
const HEARTBEAT_MS = 30_000;

export const GET: RequestHandler = ({ locals }) => {
	const userId = locals.userId;
	if (!userId) error(401, "Nicht angemeldet");

	const enc = new TextEncoder();
	let unsubscribe: (() => void) | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream({
		start(controller) {
			const send = (text: string) => {
				try {
					controller.enqueue(enc.encode(text));
				} catch {
					// Die Verbindung ist weg, waehrend wir schrieben. `cancel` raeumt
					// gleich auf - hier nichts weiter tun.
				}
			};

			// Zuerst der aktuelle Stand: wer sich verbindet, weiss sofort, ob er
			// etwas verpasst hat, ohne auf die naechste Aenderung zu warten.
			send(`event: hello\ndata: ${JSON.stringify({ seq: currentSeq(locals.db, userId) })}\n\n`);

			unsubscribe = subscribe(userId, (e) => {
				send(`event: change\ndata: ${JSON.stringify(e)}\n\n`);
			});

			if (!unsubscribe) {
				// Zu viele offene Verbindungen. Sauber schliessen statt stillschweigend
				// nichts zu senden - sonst wartet der Client ewig auf Ereignisse, die
				// nie kommen.
				send(`event: busy\ndata: {}\n\n`);
				controller.close();
				return;
			}

			heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
		},

		cancel() {
			unsubscribe?.();
			if (heartbeat) clearInterval(heartbeat);
		}
	});

	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			// Nginx puffert Antworten standardmaessig und haelt damit jedes Ereignis
			// zurueck, bis der Puffer voll ist. Der Kanal waere ohne das unbrauchbar.
			"x-accel-buffering": "no"
		}
	});
};
