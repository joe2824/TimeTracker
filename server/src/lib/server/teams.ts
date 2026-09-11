// Team-Modus: Chef, Mitglieder, Einladungslinks. Bewusst ausserhalb des
// Ende-zu-Ende-verschlüsselten Sync-Systems - siehe db/schema.ts.
import { error } from "@sveltejs/kit";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Db, DbLike } from "./db/index";
import { teamActivities, teamInvites, teamMembers, teamReports, teams } from "./db/schema";
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
	name: string,
	email?: string
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
			email: email?.trim().slice(0, 200) || null,
			tokenHash: hashSecret(token),
			createdAt: Date.now()
		})
		.run();
	return { teamMemberId: id, token, teamName: team.name };
}

/** `lastSeenAt` gilt als aktuell genug, wenn es innerhalb dieser Frist liegt - kein Schreiben bei jeder Anfrage. */
const LAST_SEEN_THROTTLE_MS = 5 * 60_000;

/** Das Mitglied hinter einem Token - `lastSeenAt` läuft nur alle paar Minuten mit, nicht bei jeder Anfrage. */
export function teamMemberFromToken(db: Db, token: string): TeamMemberAuth | null {
	const row = db.select().from(teamMembers).where(eq(teamMembers.tokenHash, hashSecret(token))).get();
	if (!row || row.revokedAt) return null;
	const now = Date.now();
	if (!row.lastSeenAt || now - row.lastSeenAt > LAST_SEEN_THROTTLE_MS) {
		db.update(teamMembers).set({ lastSeenAt: now }).where(eq(teamMembers.id, row.id)).run();
	}
	return { teamMemberId: row.id, teamId: row.teamId };
}

export interface TeamMemberRow {
	id: string;
	name: string;
	email: string | null;
	createdAt: number;
	lastSeenAt: number | null;
	revokedAt: number | null;
}

/**
 * Das Roster eines Teams, neueste Mitglieder zuerst - ein hinausgeworfenes
 * Mitglied bleibt draussen. Ohne den Filter kaeme es nach jedem Neuladen
 * zurueck (kickMember in TeamPanel.svelte entfernt es nur lokal/optimistisch)
 * und die Erinnerung zielte weiter auf jemanden, der laengst nicht mehr da ist.
 */
export function listTeamMembers(db: Db, teamId: string): TeamMemberRow[] {
	return db
		.select({
			id: teamMembers.id,
			name: teamMembers.name,
			email: teamMembers.email,
			createdAt: teamMembers.createdAt,
			lastSeenAt: teamMembers.lastSeenAt,
			revokedAt: teamMembers.revokedAt
		})
		.from(teamMembers)
		.where(and(eq(teamMembers.teamId, teamId), isNull(teamMembers.revokedAt)))
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

/** Der Stand der Liste, mit dem ein Client sie zuletzt gesehen hat - fuer die Gleichzeitigkeitsprüfung unten. */
function teamActivitiesVersion(db: DbLike, teamId: string): number {
	const rows = db
		.select({ updatedAt: teamActivities.updatedAt })
		.from(teamActivities)
		.where(eq(teamActivities.teamId, teamId))
		.all();
	return rows.reduce((max, r) => Math.max(max, r.updatedAt), 0);
}

/**
 * Die gemeinsame Liste ersetzen - voller Ersatz, kein Zusammenführen.
 *
 * In der Regel EIN Schreiber (der Chef) - `expectedVersion` fängt trotzdem den
 * Fall ab, dass derselbe Chef die Liste in zwei Tabs/Geräten offen hat: ohne
 * die Prüfung überschriebe der zuletzt speichernde Tab den anderen lautlos.
 */
export function setTeamActivities(
	db: Db,
	teamId: string,
	items: TeamActivityInput[],
	expectedVersion?: number
): TeamActivityRow[] {
	// `team_activities.id` ist ein blosses globales PRIMARY KEY, nicht je Team.
	// Eine mitgegebene Id, die schon einem ANDEREN Team gehört, dürfte den
	// Einfüge-Schritt unten nicht einfach knallen lassen (roher 500) - und erst
	// recht nicht stillschweigend fremde Zeilen überschreiben. Sauber ablehnen.
	const suppliedIds = items.map((it) => it.id).filter((id): id is string => !!id);
	if (suppliedIds.length > 0) {
		const foreign = db
			.select({ id: teamActivities.id })
			.from(teamActivities)
			.where(and(inArray(teamActivities.id, suppliedIds), ne(teamActivities.teamId, teamId)))
			.all();
		if (foreign.length > 0) error(409, "Eine Aktivität gehört zu einem anderen Team");
	}

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
		if (expectedVersion !== undefined && teamActivitiesVersion(tx, teamId) !== expectedVersion) {
			error(409, "Die Aktivitätenliste wurde inzwischen geändert");
		}
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

/**
 * Einen gesendeten Bericht ablegen - Upsert je (Mitglied, Monat): ein
 * erneuter Versand desselben Monats ERSETZT den vorigen, statt eine zweite
 * Zeile anzulegen.
 */
export function upsertTeamReport(
	db: DbLike,
	teamId: string,
	memberId: string,
	month: string,
	payload: unknown
): void {
	const submittedAt = Date.now();
	db.insert(teamReports)
		.values({ teamId, memberId, month, submittedAt, payload: JSON.stringify(payload) })
		.onConflictDoUpdate({
			target: [teamReports.memberId, teamReports.month],
			set: { submittedAt, payload: JSON.stringify(payload) }
		})
		.run();
}

/**
 * Der Chef setzt den Status von Hand - für Berichte, die auf einem anderen
 * Weg ankamen (Zuruf, Zettel). `sent=false` löscht die Zeile wieder (z.B. um
 * ein Versehen rückgängig zu machen), ohne das Mitglied zu verlieren.
 *
 * Prüft die Mitgliedschaft (nicht nur den Teambesitz, den die Route schon
 * geprüft hat): sonst liesse sich mit einer fremden memberId eine Zeile für
 * ein Mitglied anlegen, das gar nicht zu diesem Team gehört.
 */
export function setTeamReportStatus(
	db: DbLike,
	teamId: string,
	memberId: string,
	month: string,
	sent: boolean,
	/** Der submittedAt-Stand, den der Chef beim Klick vor Augen hatte - siehe unten. */
	expectedSubmittedAt?: number | null
): boolean {
	const member = db
		.select({ id: teamMembers.id })
		.from(teamMembers)
		.where(and(eq(teamMembers.id, memberId), eq(teamMembers.teamId, teamId)))
		.get();
	if (!member) return false;

	if (sent) {
		// Nicht blind upserten: ein Mitglied kann zwischen Laden der Ansicht und
		// diesem Klick selbst einen echten Bericht hochgeladen haben - der darf
		// nicht durch die von-Hand-Markierung (payload: null) ersetzt werden.
		const existing = db
			.select({ memberId: teamReports.memberId })
			.from(teamReports)
			.where(and(eq(teamReports.memberId, memberId), eq(teamReports.month, month)))
			.get();
		if (!existing) upsertTeamReport(db, teamId, memberId, month, null);
	} else {
		// Dieselbe Verwechslungsgefahr umgekehrt: zwischen Laden der Ansicht und
		// diesem Klick könnte ein echter Bericht eingetroffen sein. Stimmt der
		// mitgegebene Stand nicht mehr mit der Datenbank überein, nicht blind
		// darüberlöschen, sondern ablehnen - der Client lädt dann neu.
		const existing = db
			.select({ submittedAt: teamReports.submittedAt })
			.from(teamReports)
			.where(and(eq(teamReports.memberId, memberId), eq(teamReports.month, month)))
			.get();
		if (existing && expectedSubmittedAt !== undefined && existing.submittedAt !== expectedSubmittedAt) {
			error(409, "Der Bericht wurde inzwischen geändert");
		}
		db.delete(teamReports)
			.where(and(eq(teamReports.memberId, memberId), eq(teamReports.month, month)))
			.run();
	}
	return true;
}

export interface TeamReportStatus {
	memberId: string;
	memberName: string;
	memberEmail: string | null;
	/** null = für diesen Monat noch nichts eingegangen. */
	submittedAt: number | null;
	payload: unknown | null;
}

/** Für einen Monat: jedes Mitglied, ob und wann es gesendet hat - samt Inhalt. */
export function listTeamReports(db: Db, teamId: string, month: string): TeamReportStatus[] {
	const rows = db
		.select()
		.from(teamReports)
		.where(and(eq(teamReports.teamId, teamId), eq(teamReports.month, month)))
		.all();
	const byMember = new Map(rows.map((r) => [r.memberId, r]));

	const members = listTeamMembers(db, teamId);
	const activeIds = new Set(members.map((m) => m.id));

	// listTeamMembers lässt hinausgeworfene Mitglieder aussen vor - ausser eines
	// hat für GENAU diesen Monat schon einen Bericht abgegeben: der darf dem
	// Chef nicht verloren gehen, nur weil das Mitglied inzwischen weg ist.
	const revokedSubmitters =
		rows.length === 0
			? []
			: db
					.select({
						id: teamMembers.id,
						name: teamMembers.name,
						email: teamMembers.email
					})
					.from(teamMembers)
					.where(
						and(eq(teamMembers.teamId, teamId), inArray(teamMembers.id, rows.map((r) => r.memberId)))
					)
					.all()
					.filter((m) => !activeIds.has(m.id));

	return [...members, ...revokedSubmitters].map((m) => {
		const row = byMember.get(m.id);
		return {
			memberId: m.id,
			memberName: m.name,
			memberEmail: m.email,
			submittedAt: row?.submittedAt ?? null,
			payload: row ? JSON.parse(row.payload) : null
		};
	});
}
