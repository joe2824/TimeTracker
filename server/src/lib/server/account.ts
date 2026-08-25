// Ein Konto vollstaendig entfernen.
//
// "Entkoppeln" hat zwei Bedeutungen, und sie auseinanderzuhalten ist hier die
// ganze Arbeit:
//
//   - Ein GERAET loesen. Der Zugang dieses einen Geraets erlischt, das Konto und
//     alle anderen Geraete bleiben. Das macht `revokeDevice` in auth.ts.
//   - Das KONTO aufloesen. Dann verschwindet alles, was der Server hat.
//
// Diese Datei ist der zweite Fall. Sie loescht ausdruecklich Tabelle fuer
// Tabelle, obwohl das Schema kaskadiert: eine Loeschung, die man lesen kann,
// ist eine, die man pruefen kann. Und zwei Tabellen kaskadieren gar nicht -
// `pairings` und `challenges` tragen bewusst keinen Fremdschluessel, weil ihre
// Zeilen entstehen, bevor das Konto feststeht.
import { eq } from "drizzle-orm";
import type { DbLike } from "./db";
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

/** Was entfernt wurde - damit der Client es dem Menschen zeigen kann. */
export interface DeleteSummary {
	records: number;
	devices: number;
	passkeys: number;
	wraps: number;
}

/**
 * Alles zu diesem Konto entfernen.
 *
 * In EINER Transaktion: ein halb geloeschtes Konto waere schlimmer als ein
 * nicht geloeschtes - es haette keinen Zugang mehr, aber die Daten laegen noch
 * da, und niemand koennte sie noch loeschen lassen.
 *
 * Danach ist der Server in genau dem Zustand, in dem er vor der Registrierung
 * war. Es gibt keinen Papierkorb und keine Frist: was hier verschwindet, ist
 * weg. Das ist Absicht - ein Dienst, der nicht entschluesseln kann, hat auch
 * keinen Grund, Chiffrate aufzubewahren, die niemand mehr abholt.
 */
export function deleteAccount(db: DbLike, userId: string): DeleteSummary {
	const zaehle = (tabelle: typeof records | typeof devices | typeof credentials | typeof keyWraps) =>
		db.select().from(tabelle).where(eq(tabelle.userId, userId)).all().length;

	const summe: DeleteSummary = {
		records: zaehle(records),
		devices: zaehle(devices),
		passkeys: zaehle(credentials),
		wraps: zaehle(keyWraps)
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

	return summe;
}

/**
 * Das Schreibprotokoll in die Datenbank schieben und abschneiden.
 *
 * `secure_delete` nullt die Seiten der HAUPTdatei. Im Schreibprotokoll stehen
 * daneben aber noch die alten Fassungen derselben Seiten - mit dem Chiffrat
 * darin. Erst dieser Schritt schreibt die genullten Seiten hinueber und wirft
 * das Protokoll weg.
 *
 * Nur nach dem Aufloesen eines Kontos, nicht laufend: ein Abschneiden bei jedem
 * Schreibvorgang naehme WAL genau den Vorteil, wegen dem es eingeschaltet ist.
 */
export function raeumeSpuren(raw: { pragma(s: string): unknown }): void {
	try {
		raw.pragma("wal_checkpoint(TRUNCATE)");
	} catch {
		// Ein misslungenes Aufraeumen darf die Loeschung nicht zurueckdrehen - die
		// Daten sind weg, das ist die Zusage. Dass die Datei noch Reste enthaelt,
		// ist ein Mangel, aber kein Grund, das Konto wiederzubeleben.
	}
}
