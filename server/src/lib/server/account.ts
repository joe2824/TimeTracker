// Ein Konto vollständig entfernen. "Entkoppeln" heisst zweierlei:
//
//   - Ein GERAET lösen. Der Zugang dieses einen Geräts erlischt, das Konto und
//     alle anderen Geräte bleiben. Das macht `revokeDevice` in auth.ts.
//   - Das KONTO auflösen. Dann verschwindet alles, was der Server hat.
import { and, asc, eq, gte, lt, or, sql } from "drizzle-orm";
import type { Db, DbLike } from "./db/index";
import {
	challenges,
	credentials,
	devices,
	invites,
	keyWraps,
	pairings,
	records,
	sessions,
	teamAdmins,
	teamMembers,
	teamReports,
	teams,
	users
} from "./db/schema";

/** Wie viele Konten es auf diesem Server gibt. Für die Verwaltungsansicht. */
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
	/** Eigene Teams, die an den dienstältesten Verwalter übergingen. */
	teamsTransferred: number;
	/** Eigene Teams ohne Verwalter - die gehen samt Mitgliedern und Berichten mit. */
	teamsDeleted: number;
}

/**
 * Eigene Teams vor dem Löschen an den dienstältesten Verwalter übergeben -
 * sonst nähme die Kaskade über teams.owner_user_id das Team samt Mitgliedern,
 * Berichten und allen übrigen Verwaltern still mit.
 */
function handOverOwnedTeams(db: DbLike, userId: string): { transferred: number; deleted: number } {
	const owned = db.select({ id: teams.id }).from(teams).where(eq(teams.ownerUserId, userId)).all();
	let transferred = 0;
	for (const { id } of owned) {
		const heir = db
			.select({ userId: teamAdmins.userId })
			.from(teamAdmins)
			.where(eq(teamAdmins.teamId, id))
			.orderBy(asc(teamAdmins.createdAt))
			.get();
		if (!heir) continue;
		db.update(teams).set({ ownerUserId: heir.userId }).where(eq(teams.id, id)).run();
		db.delete(teamAdmins).where(and(eq(teamAdmins.teamId, id), eq(teamAdmins.userId, heir.userId))).run();
		transferred++;
	}
	return { transferred, deleted: owned.length - transferred };
}

/** Alles zu diesem Konto entfernen. */
export function deleteAccount(db: DbLike, userId: string): DeleteSummary {
	const countRows = (table: typeof records | typeof devices | typeof credentials | typeof keyWraps) =>
		db.select().from(table).where(eq(table.userId, userId)).all().length;

	const summary: DeleteSummary = {
		records: countRows(records),
		devices: countRows(devices),
		passkeys: countRows(credentials),
		wraps: countRows(keyWraps),
		teamsTransferred: 0,
		teamsDeleted: 0
	};

	const handedOver = handOverOwnedTeams(db, userId);
	summary.teamsTransferred = handedOver.transferred;
	summary.teamsDeleted = handedOver.deleted;

	db.delete(records).where(eq(records.userId, userId)).run();
	db.delete(keyWraps).where(eq(keyWraps.userId, userId)).run();
	db.delete(credentials).where(eq(credentials.userId, userId)).run();
	db.delete(devices).where(eq(devices.userId, userId)).run();
	db.delete(sessions).where(eq(sessions.userId, userId)).run();
	// Ohne Fremdschlüssel - siehe oben. Würde man sie stehen lassen, bliebe ein
	// offener Kopplungsvorgang zurück, der auf ein Konto zeigt, das es nicht
	// mehr gibt.
	db.delete(pairings).where(eq(pairings.userId, userId)).run();
	db.delete(challenges).where(eq(challenges.userId, userId)).run();

	// Der Einladungscode bleibt verbraucht: wäre er es nicht, könnte man sich
	// durch Löschen und Neuanlegen beliebig viele Konten damit verschaffen. Nur
	// der Verweis auf den Menschen fällt weg - der soll keine Spur hinterlassen.
	db.update(invites).set({ usedBy: null }).where(eq(invites.usedBy, userId)).run();

	db.delete(users).where(eq(users.id, userId)).run();

	return summary;
}

/**
 * Konten löschen, die seit `maxAgeMs` weder ein Gerät noch einen Passkey noch
 * eine gültige Browser-Sitzung benutzt haben - wer so lange nicht vorbeischaut,
 * benutzt die Anwendung nicht mehr. Eine Sitzung zählt schon durch ihr blosses
 * Bestehen: sie verlängert sich bei jeder Nutzung (touchSession in auth.ts),
 * ein Chef, der nur im Browser arbeitet und nie ein Gerät koppelt oder erneut
 * einen Passkey anlegt, würde sonst trotz laufender Nutzung als inaktiv
 * gelten. Ebenso ein Team, dessen Mitglieder sich melden oder Berichte
 * senden. Ein Konto ohne jedes Gerät/Passkey/Sitzung (sollte nicht vorkommen,
 * ausser bei einem abgebrochenen Anlegen) zählt über sein `createdAt`.
 * Liefert die Zahl gelöschter Konten.
 *
 * Prüft je Kandidat statt die kompletten Geräte-/Passkey-/Sitzungstabellen in
 * den Speicher zu holen: nur Konten, die schon älter als `maxAgeMs` sind,
 * kommen überhaupt infrage - für die reicht ein indizierter Blick über
 * `userId` (anders als `lastSeenAt`/`lastUsedAt`/`expiresAt` selbst, die
 * unindiziert sind).
 */
export function deleteInactiveAccounts(db: Db, maxAgeMs: number, now = Date.now()): number {
	const cutoff = now - maxAgeMs;

	// Server-Admins nie: ohne sie liesse sich der Server nicht mehr verwalten,
	// und wer ihn nur selten betreut, ist deshalb nicht weg.
	const candidates = db
		.select({ id: users.id })
		.from(users)
		.where(and(lt(users.createdAt, cutoff), eq(users.isAdmin, false)))
		.all();

	const isActive = (userId: string): boolean => {
		const recentDevice = db
			.select({ id: devices.id })
			.from(devices)
			.where(and(eq(devices.userId, userId), gte(devices.lastSeenAt, cutoff)))
			.get();
		if (recentDevice) return true;

		const recentCredential = db
			.select({ id: credentials.id })
			.from(credentials)
			.where(and(eq(credentials.userId, userId), gte(credentials.lastUsedAt, cutoff)))
			.get();
		if (recentCredential) return true;

		const validSession = db
			.select({ id: sessions.id })
			.from(sessions)
			.where(and(eq(sessions.userId, userId), gte(sessions.expiresAt, now)))
			.get();
		if (validSession) return true;

		// Mitglieder und Berichte laufen über den Team-Token, nicht über ein Gerät
		// des Chefs: ein Team, das noch benutzt wird, hält sein Konto am Leben.
		// Sonst nähme die Kaskade Team, Mitglieder und Berichte mit.
		const recentMember = db
			.select({ id: teamMembers.id })
			.from(teamMembers)
			.innerJoin(teams, eq(teams.id, teamMembers.teamId))
			.where(
				and(
					eq(teams.ownerUserId, userId),
					// Ein Mitglied, das erst kürzlich beigetreten ist, hat vielleicht noch nie
					// abgerufen - der Beitritt selbst ist auch Aktivität.
					or(gte(teamMembers.lastSeenAt, cutoff), gte(teamMembers.createdAt, cutoff))
				)
			)
			.get();
		if (recentMember) return true;

		const recentReport = db
			.select({ memberId: teamReports.memberId })
			.from(teamReports)
			.innerJoin(teams, eq(teams.id, teamReports.teamId))
			.where(and(eq(teams.ownerUserId, userId), gte(teamReports.submittedAt, cutoff)))
			.get();
		return !!recentReport;
	};

	const inactive = candidates.filter((u) => !isActive(u.id));

	// Je Konto alles oder nichts, wie beim Löschen über /api/me.
	for (const { id } of inactive) db.transaction((tx) => deleteAccount(tx, id));
	if (inactive.length > 0) cleanupTraces(db.$client);
	return inactive.length;
}

/** Das Schreibprotokoll in die Datenbank schieben und abschneiden. */
export function cleanupTraces(raw: { pragma(s: string): unknown }): void {
	try {
		raw.pragma("wal_checkpoint(TRUNCATE)");
	} catch {
		// Ein misslungenes Aufräumen darf die Löschung nicht zurückdrehen - die
		// Daten sind weg, das ist die Zusage. Dass die Datei noch Reste enthält,
		// ist ein Mangel, aber kein Grund, das Konto wiederzubeleben.
	}
}
