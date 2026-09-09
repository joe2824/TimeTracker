// Team-Modus: Chef, Mitglieder, Einladungslinks. Bewusst ausserhalb des
// Ende-zu-Ende-verschlüsselten Sync-Systems - siehe db/schema.ts.
import { error } from "@sveltejs/kit";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db, DbLike } from "./db/index";
import { teamActivities, teamInvites, teamMembers, teams } from "./db/schema";
import { generateInviteCode } from "./invites";
import { hashSecret, newSecret } from "./auth";

export interface TeamRow {
	id: string;
	ownerUserId: string;
	name: string;
	createdAt: number;
}

/** Ein Team anlegen. */
export function createTeam(db: DbLike, ownerUserId: string, name: string): TeamRow {
	const row = { id: crypto.randomUUID(), ownerUserId, name: name.slice(0, 100), createdAt: Date.now() };
	db.insert(teams).values(row).run();
	return row;
}

/** Die Teams eines Chefs, neueste zuerst. */
export function listTeams(db: Db, ownerUserId: string): TeamRow[] {
	return db.select().from(teams).where(eq(teams.ownerUserId, ownerUserId)).orderBy(desc(teams.createdAt)).all();
}

/** Ein Team samt Besitzprüfung - wirft 404, wenn es nicht existiert oder einem anderen Konto gehört.
 *  404 statt 403: ob es das Team gibt, geht niemand ausser dem Besitzer etwas an. */
export function requireOwnTeam(db: Db, ownerUserId: string, teamId: string): TeamRow {
	const row = db.select().from(teams).where(eq(teams.id, teamId)).get();
	if (!row || row.ownerUserId !== ownerUserId) error(404, "Team unbekannt");
	return row;
}

export interface TeamInviteRow {
	code: string;
	teamId: string;
	createdAt: number;
	expiresAt: number | null;
	revokedAt: number | null;
}

/** Der aktuell gültige Link dieses Teams - oder null. */
export function activeTeamInvite(db: Db, teamId: string): TeamInviteRow | null {
	const now = Date.now();
	const rows = db
		.select()
		.from(teamInvites)
		.where(and(eq(teamInvites.teamId, teamId), isNull(teamInvites.revokedAt)))
		.orderBy(desc(teamInvites.createdAt))
		.all();
	return rows.find((r) => !r.expiresAt || r.expiresAt > now) ?? null;
}

/**
 * Einen neuen Link erzeugen - widerruft dabei alle bisher aktiven, damit stets
 * höchstens einer gilt ("Neuen Link erzeugen" ersetzt den alten).
 */
export function rotateTeamInvite(db: Db, teamId: string): TeamInviteRow {
	const now = Date.now();
	db.update(teamInvites)
		.set({ revokedAt: now })
		.where(and(eq(teamInvites.teamId, teamId), isNull(teamInvites.revokedAt)))
		.run();
	const row = { code: generateInviteCode(), teamId, createdAt: now, expiresAt: null, revokedAt: null };
	db.insert(teamInvites).values(row).run();
	return row;
}

/** Team hinter einem gültigen, nicht widerrufenen/abgelaufenen Code - oder null. */
export function teamFromInviteCode(db: DbLike, code: string): TeamRow | null {
	const invite = db.select().from(teamInvites).where(eq(teamInvites.code, code)).get();
	if (!invite || invite.revokedAt) return null;
	if (invite.expiresAt && invite.expiresAt < Date.now()) return null;
	return db.select().from(teams).where(eq(teams.id, invite.teamId)).get() ?? null;
}

export interface TeamMemberAuth {
	teamMemberId: string;
	teamId: string;
}

/**
 * Beitreten - legt immer eine NEUE Mitgliedszeile an (rein link-getrieben,
 * kein Abgleich gegen vorhandene Namen/E-Mails).
 */
export function joinTeam(
	db: DbLike,
	code: string,
	name: string
): { teamMemberId: string; token: string; teamName: string } | null {
	const team = teamFromInviteCode(db, code);
	if (!team) return null;
	const id = crypto.randomUUID();
	const token = newSecret();
	db.insert(teamMembers)
		.values({
			id,
			teamId: team.id,
			name: name.slice(0, 100) || "Ohne Namen",
			tokenHash: hashSecret(token),
			createdAt: Date.now()
		})
		.run();
	return { teamMemberId: id, token, teamName: team.name };
}

/** Das Mitglied hinter einem Token - und `lastSeenAt` gleich mit aktualisiert. */
export function teamMemberFromToken(db: Db, token: string): TeamMemberAuth | null {
	const row = db.select().from(teamMembers).where(eq(teamMembers.tokenHash, hashSecret(token))).get();
	if (!row || row.revokedAt) return null;
	db.update(teamMembers).set({ lastSeenAt: Date.now() }).where(eq(teamMembers.id, row.id)).run();
	return { teamMemberId: row.id, teamId: row.teamId };
}

export interface TeamMemberRow {
	id: string;
	name: string;
	createdAt: number;
	lastSeenAt: number | null;
	revokedAt: number | null;
}

/** Das Roster eines Teams, neueste Mitglieder zuerst. */
export function listTeamMembers(db: Db, teamId: string): TeamMemberRow[] {
	return db
		.select({
			id: teamMembers.id,
			name: teamMembers.name,
			createdAt: teamMembers.createdAt,
			lastSeenAt: teamMembers.lastSeenAt,
			revokedAt: teamMembers.revokedAt
		})
		.from(teamMembers)
		.where(eq(teamMembers.teamId, teamId))
		.orderBy(desc(teamMembers.createdAt))
		.all();
}

/** Ein Mitglied hinauswerfen - sein Token wird sofort ungültig. */
export function revokeTeamMember(db: Db, teamId: string, memberId: string): boolean {
	const r = db
		.update(teamMembers)
		.set({ revokedAt: Date.now() })
		.where(and(eq(teamMembers.id, memberId), eq(teamMembers.teamId, teamId), isNull(teamMembers.revokedAt)))
		.run();
	return r.changes > 0;
}

/** Team-Mitglied sein - wirft 401, wenn der `x-team-token`-Kopf fehlt oder ungültig war. */
export function requireTeamMember(locals: { teamMemberId: string | null; teamId: string | null }): string {
	if (!locals.teamMemberId || !locals.teamId) error(401, "Kein Team-Zugang");
	return locals.teamId;
}

export interface TeamActivityRow {
	id: string;
	teamId: string;
	name: string;
	isAbsence: boolean;
	sortOrder: number;
	color: string | null;
	archived: boolean;
	updatedAt: number;
}

export interface TeamActivityInput {
	id?: string;
	name: string;
	isAbsence: boolean;
	sortOrder: number;
	color?: string | null;
	archived: boolean;
}

/**
 * Die gemeinsame Liste ersetzen - voller Ersatz, kein Zusammenführen.
 *
 * Es gibt immer nur EINEN Schreiber (den Chef) - anders als bei den
 * Personendaten braucht es hier kein `updatedAt`/`rev`-Konfliktverfahren.
 */
export function setTeamActivities(db: Db, teamId: string, items: TeamActivityInput[]): TeamActivityRow[] {
	const now = Date.now();
	const rows: TeamActivityRow[] = items.map((it, i) => ({
		id: it.id ?? crypto.randomUUID(),
		teamId,
		name: it.name.slice(0, 100),
		isAbsence: it.isAbsence,
		sortOrder: it.sortOrder ?? i,
		color: it.color ?? null,
		archived: it.archived,
		updatedAt: now
	}));
	db.transaction((tx) => {
		tx.delete(teamActivities).where(eq(teamActivities.teamId, teamId)).run();
		for (const row of rows) tx.insert(teamActivities).values(row).run();
	});
	return rows;
}

/** Die gemeinsame Liste, sortiert wie der Chef sie angeordnet hat. */
export function listTeamActivities(db: Db, teamId: string): TeamActivityRow[] {
	return db
		.select()
		.from(teamActivities)
		.where(eq(teamActivities.teamId, teamId))
		.orderBy(teamActivities.sortOrder)
		.all();
}
