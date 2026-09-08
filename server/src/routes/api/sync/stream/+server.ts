// Der Weckruf-Kanal.
import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { subscribe } from "$lib/server/events";
import { currentSeq } from "$lib/server/sync";

/** Alle 30 Sekunden ein Lebenszeichen. */
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
					// Die Verbindung ist weg, während wir schrieben. `cancel` räumt
					// gleich auf - hier nichts weiter tun.
				}
			};

			// Zuerst der aktuelle Stand: wer sich verbindet, weiss sofort, ob er
			// etwas verpasst hat, ohne auf die nächste Änderung zu warten.
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
			// Nginx puffert Antworten standardmässig und hält damit jedes Ereignis
			// zurück, bis der Puffer voll ist. Der Kanal wäre ohne das unbrauchbar.
			"x-accel-buffering": "no"
		}
	});
};
