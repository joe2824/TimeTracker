// Ein Konto vollstaendig entfernen. "Entkoppeln" heisst zweierlei:
//
//   - Ein GERAET loesen. Der Zugang dieses einen Geraets erlischt, das Konto und
//     alle anderen Geraete bleiben. Das macht `revokeDevice` in auth.ts.
//   - Das KONTO aufloesen. Dann verschwindet alles, was der Server hat.
import { eq, sql } from "drizzle-orm";
import type { DbLike } from "./db/index";
import {
	challenges,
	credentials,
	devices,
	invites,
	keyWraps,
	pairings,
	records,
	sessions,
	users
} from "./db/schema";

/** Wie viele Konten es auf diesem Server gibt. Fuer die Verwaltungsansicht. */
export function countUsers(db: DbLike): number {
	const row = db.select({ n: sql<number>`count(*)` }).from(users).get();
	return Number(row?.n ?? 0);
}

/** Was entfernt wurde - damit der Client es dem Menschen zeigen kann. */
export interface DeleteSummary {
	records: number;
	devices: number;
	passkeys: number;
	wraps: number;
}

/** Alles zu diesem Konto entfernen. */
export function deleteAccount(db: DbLike, userId: string): DeleteSummary {
	const countRows = (table: typeof records | typeof devices | typeof credentials | typeof keyWraps) =>
		db.select().from(table).where(eq(table.userId, userId)).all().length;

	const summary: DeleteSummary = {
		records: countRows(records),
		devices: countRows(devices),
		passkeys: countRows(credentials),
		wraps: countRows(keyWraps)
	};

	db.delete(records).where(eq(records.userId, userId)).run();
	db.delete(keyWraps).where(eq(keyWraps.userId, userId)).run();
	db.delete(credentials).where(eq(credentials.userId, userId)).run();
	db.delete(devices).where(eq(devices.userId, userId)).run();
	db.delete(sessions).where(eq(sessions.userId, userId)).run();
	// Ohne Fremdschluessel - siehe oben. Wuerde man sie stehen lassen, bliebe ein
	// offener Kopplungsvorgang zurueck, der auf ein Konto zeigt, das es nicht
	// mehr gibt.
	db.delete(pairings).where(eq(pairings.userId, userId)).run();
	db.delete(challenges).where(eq(challenges.userId, userId)).run();

	// Der Einladungscode bleibt verbraucht: waere er es nicht, koennte man sich
	// durch Loeschen und Neuanlegen beliebig viele Konten damit verschaffen. Nur
	// der Verweis auf den Menschen faellt weg - der soll keine Spur hinterlassen.
	db.update(invites).set({ usedBy: null }).where(eq(invites.usedBy, userId)).run();

	db.delete(users).where(eq(users.id, userId)).run();

	return summary;
}

/** Das Schreibprotokoll in die Datenbank schieben und abschneiden. */
export function cleanupTraces(raw: { pragma(s: string): unknown }): void {
	try {
		raw.pragma("wal_checkpoint(TRUNCATE)");
	} catch {
		// Ein misslungenes Aufraeumen darf die Loeschung nicht zurueckdrehen - die
		// Daten sind weg, das ist die Zusage. Dass die Datei noch Reste enthaelt,
		// ist ein Mangel, aber kein Grund, das Konto wiederzubeleben.
	}
}
