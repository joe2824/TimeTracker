// Was vor jeder Anfrage passiert: Datenbank bereitstellen und feststellen, wem
// die Anfrage gehoert.
//
// Ab hier arbeitet jeder Endpunkt nur noch mit `locals.userId` - und schraenkt
// JEDE Abfrage darauf ein. Das ist die gesamte Mandantentrennung, und sie ist
// deshalb so knapp, weil sie an genau einer Stelle passiert.
import type { Handle } from "@sveltejs/kit";
import { openDb } from "$lib/server/db";
import { cleanupExpired, deviceFromToken, userFromSession } from "$lib/server/auth";
import { DB_FILE } from "$lib/server/config";
import { SESSION_COOKIE } from "$lib/server/session";

const { db } = openDb(DB_FILE);

cleanupExpired(db);
// Stuendlich, damit abgebrochene Anmeldeversuche und abgelaufene Sitzungen nicht
// unbegrenzt liegen bleiben. `unref`, damit dieser Zeitgeber den Prozess beim
// Herunterfahren nicht offenhaelt.
setInterval(() => cleanupExpired(db), 3600_000).unref();

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.db = db;
	event.locals.userId = null;
	event.locals.deviceId = null;

	// Das Geraete-Token zuerst: der Desktop schickt kein Cookie, und ein
	// mitgeschicktes Token ist die ausdruecklichere Angabe.
	const auth = event.request.headers.get("authorization");
	if (auth?.startsWith("Bearer ")) {
		const device = deviceFromToken(db, auth.slice(7));
		if (device) {
			event.locals.userId = device.userId;
			event.locals.deviceId = device.deviceId;
		}
	}

	if (!event.locals.userId) {
		const cookie = event.cookies.get(SESSION_COOKIE);
		if (cookie) event.locals.userId = userFromSession(db, cookie);
	}

	return resolve(event);
};
