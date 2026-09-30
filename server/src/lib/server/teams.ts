// Team-Modus: Chef, Mitglieder, Einladungslinks. Bewusst ausserhalb des
// Ende-zu-Ende-verschlüsselten Sync-Systems - siehe db/schema.ts.
import type { TeamActivity, TeamActivityInput, TeamReportStatus } from "$shared/apiTypes";
export type { TeamActivityInput, TeamReportStatus };
import { error } from "@sveltejs/kit";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Db, DbLike } from "./db/index";
import {
	teamActivities,
	teamAdminInvites,
	teamAdmins,
	teamInvites,
	teamMembers,
	teamReports,
	teams,
	users
} from "./db/schema";
import { generateInviteCode, inviteCodeCandidates } from "./invites";
import { hashSecret, newSecret } from "./auth";
import { cleanEmail } from "$shared/email";
import { readLabel, TEAM_TEXT_MAX } from "$shared/labels";

export interface TeamRow {
	id: string;
	ownerUserId: string;
	name: string;
	createdAt: number;
	/** Nur in listTeams() gefuellt - dort steht sie fuer die anfragende Person. */
	role?: "owner" | "admin";
}

/** Ein Team anlegen. */
export function createTeam(db: DbLike, ownerUserId: string, name: string): TeamRow {
	const row = { id: crypto.randomUUID(), ownerUserId, name: name.slice(0, TEAM_TEXT_MAX), createdAt: Date.now() };
	db.insert(teams).values(row).run();
	return row;
}

/**
 * Die Teams, bei denen dieses Konto mitreden darf - als Chef ODER als
 * Verwalter, neueste zuerst. `role` sagt, welches von beiden.
 */
export function listTeams(db: Db, userId: string): TeamRow[] {
	const owned = db
		.select()
		.from(teams)
		.where(eq(teams.ownerUserId, userId))
		.all()
		.map((t) => ({ ...t, role: "owner" as const }));
	const administered = db
		.select({ id: teams.id, ownerUserId: teams.ownerUserId, name: teams.name, createdAt: teams.createdAt })
		.from(teamAdmins)
		.innerJoin(teams, eq(teams.id, teamAdmins.teamId))
		.where(eq(teamAdmins.userId, userId))
		.all()
		.map((t) => ({ ...t, role: "admin" as const }));
	return [...owned, ...administered].sort((a, b) => b.createdAt - a.createdAt);
}

/** Ein Team samt Besitzprüfung - wirft 404, wenn es nicht existiert oder einem anderen Konto gehört.
 *  404 statt 403: ob es das Team gibt, geht niemand ausser dem Besitzer etwas an. */
export function requireOwnTeam(db: Db, ownerUserId: string, teamId: string): TeamRow {
	const row = db.select().from(teams).where(eq(teams.id, teamId)).get();
	if (!row || row.ownerUserId !== ownerUserId) error(404, "Team unbekannt");
	return row;
}

/**
 * Ein Team endgültig löschen - Einladungen, Mitglieder, Aktivitäten und
 * Berichte hängen per onDelete: cascade daran (db/schema.ts) und gehen mit.
 * Ruft requireOwnTeam selbst nicht auf - der Aufrufer (Route) hat die
 * Besitzprüfung meist schon für eine andere Antwort gebraucht.
 */
export function deleteTeam(db: Db, teamId: string): void {
	db.delete(teams).where(eq(teams.id, teamId)).run();
}

export interface TeamInviteRow {
	code: string;
	teamId: string;
	createdAt: number;
	expiresAt: number | null;
	revokedAt: number | null;
}

/** Ein Verwalter-Link hat dieselbe Form wie ein Beitritts-Link. */
export type TeamAdminInviteRow = TeamInviteRow;

/** Ein Verwalter-Link oeffnet alle Berichte - weitergeleitet soll er nicht ewig gelten. */
export const ADMIN_INVITE_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * Die beiden Arten von Team-Links: Beitritt (ohne Ablauf) und Verwalter (mit).
 * Tabelle und Frist sind das Einzige, worin sie sich unterscheiden.
 */
interface InviteKind {
	table: typeof teamInvites | typeof teamAdminInvites;
	/** null = gilt bis zum Widerruf. */
	ttlMs: number | null;
}
const MEMBER_INVITES: InviteKind = { table: teamInvites, ttlMs: null };
const ADMIN_INVITES: InviteKind = { table: teamAdminInvites, ttlMs: ADMIN_INVITE_TTL_MS };

/**
 * Wann ein Link abläuft - null für nie. Verwalter-Links aus den Betas stehen
 * ohne Ablauf in der DB; sie laufen ab ihrer Erzeugung genauso ab.
 */
function inviteExpiresAt(kind: InviteKind, r: { createdAt: number; expiresAt: number | null }): number | null {
	return r.expiresAt ?? (kind.ttlMs === null ? null : r.createdAt + kind.ttlMs);
}

/** Gültig heisst: nicht widerrufen und die Frist liegt noch in der Zukunft. */
function isInviteLive(kind: InviteKind, r: TeamInviteRow, now: number): boolean {
	if (r.revokedAt) return false;
	const expiresAt = inviteExpiresAt(kind, r);
	return expiresAt === null || expiresAt > now;
}

function revokeInvites(db: DbLike, kind: InviteKind, teamId: string, now: number): void {
	db.update(kind.table)
		.set({ revokedAt: now })
		.where(and(eq(kind.table.teamId, teamId), isNull(kind.table.revokedAt)))
		.run();
}

function activeInvite(db: Db, kind: InviteKind, teamId: string): TeamInviteRow | null {
	const now = Date.now();
	const rows: TeamInviteRow[] = db
		.select()
		.from(kind.table)
		.where(and(eq(kind.table.teamId, teamId), isNull(kind.table.revokedAt)))
		.orderBy(desc(kind.table.createdAt))
		.all();
	return rows.find((r) => isInviteLive(kind, r, now)) ?? null;
}

/**
 * Einen neuen Link erzeugen - widerruft dabei alle bisher aktiven, damit stets
 * höchstens einer gilt ("Neuen Link erzeugen" ersetzt den alten).
 */
function rotateInvite(db: Db, kind: InviteKind, teamId: string): TeamInviteRow {
	const now = Date.now();
	revokeInvites(db, kind, teamId, now);
	const row = {
		code: generateInviteCode(),
		teamId,
		createdAt: now,
		expiresAt: kind.ttlMs === null ? null : now + kind.ttlMs,
		revokedAt: null
	};
	db.insert(kind.table).values(row).run();
	return row;
}

/** Team hinter einem gültigen Code - oder null. Getipptes wird wie beim Konto-Code verziehen. */
function teamFromCode(db: DbLike, kind: InviteKind, code: string): TeamRow | null {
	const invite: TeamInviteRow | undefined = db
		.select()
		.from(kind.table)
		.where(inArray(kind.table.code, inviteCodeCandidates(code)))
		.get();
	if (!invite || !isInviteLive(kind, invite, Date.now())) return null;
	return db.select().from(teams).where(eq(teams.id, invite.teamId)).get() ?? null;
}

/** Der aktuell gültige Beitritts-Link dieses Teams - oder null. */
export function activeTeamInvite(db: Db, teamId: string): TeamInviteRow | null {
	return activeInvite(db, MEMBER_INVITES, teamId);
}

/** Neuen Beitritts-Link erzeugen, der bisherige gilt nicht mehr. */
export function rotateTeamInvite(db: Db, teamId: string): TeamInviteRow {
	return rotateInvite(db, MEMBER_INVITES, teamId);
}

/** Team hinter einem gültigen Beitritts-Code - oder null. */
export function teamFromInviteCode(db: DbLike, code: string): TeamRow | null {
	return teamFromCode(db, MEMBER_INVITES, code);
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
			name: readLabel(name, "Ohne Namen", TEAM_TEXT_MAX),
			email: cleanEmail(email),
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

// ---------- Verwalter: ein zweites Konto neben dem Chef ----------
//
// Anders als teamMembers ein echtes Konto (users.id) - darf alles Operative
// (Aktivitaeten, Mitglieder, Berichte, den einfachen Beitritts-Link), aber
// nicht das Team loeschen, weitere Verwalter einladen/entfernen oder den Besitz
// uebergeben. Diese vier Routen bleiben requireOwnTeam vorbehalten, alles
// andere wechselt auf requireTeamAccess.

export function isTeamAdmin(db: Db, teamId: string, userId: string): boolean {
	return !!db
		.select({ userId: teamAdmins.userId })
		.from(teamAdmins)
		.where(and(eq(teamAdmins.teamId, teamId), eq(teamAdmins.userId, userId)))
		.get();
}

/**
 * Ein Team, dem dieses Konto als Chef ODER Verwalter angehoert - wirft 404
 * sonst. Fuer die operativen Routen; wo nur der Chef darf, bleibt es bei
 * requireOwnTeam.
 */
export function requireTeamAccess(db: Db, userId: string, teamId: string): TeamRow {
	const row = db.select().from(teams).where(eq(teams.id, teamId)).get();
	if (!row) error(404, "Team unbekannt");
	if (row.ownerUserId === userId || isTeamAdmin(db, teamId, userId)) return row;
	error(404, "Team unbekannt");
}

export interface TeamAdminRow {
	userId: string;
	displayName: string;
	email: string | null;
	createdAt: number;
}

/** Die Verwalter eines Teams, neueste zuerst - der Chef steht nicht mit drin. */
export function listTeamAdmins(db: Db, teamId: string): TeamAdminRow[] {
	return db
		.select({
			userId: teamAdmins.userId,
			displayName: users.displayName,
			email: users.email,
			createdAt: teamAdmins.createdAt
		})
		.from(teamAdmins)
		.innerJoin(users, eq(users.id, teamAdmins.userId))
		.where(eq(teamAdmins.teamId, teamId))
		.orderBy(desc(teamAdmins.createdAt))
		.all();
}

/**
 * Einen Verwalter wieder entfernen - Chef-only, sein eigener Zugang bleibt (der laeuft ueber ownerUserId).
 * Widerruft dabei auch den aktuell gueltigen Verwalter-Link: sonst kaeme die entfernte Person ueber
 * denselben Code sofort wieder hinein. Fuer eine neue Einladung muss der Chef bewusst "Neuen Link
 * erzeugen" klicken.
 */
export function removeTeamAdmin(db: Db, teamId: string, userId: string): boolean {
	const r = db
		.delete(teamAdmins)
		.where(and(eq(teamAdmins.teamId, teamId), eq(teamAdmins.userId, userId)))
		.run();
	if (r.changes === 0) return false;
	revokeInvites(db, ADMIN_INVITES, teamId, Date.now());
	return true;
}

/**
 * Besitz uebergeben - das Ziel muss bereits Verwalter sein (kein Uebergeben an
 * ein x-beliebiges Konto per Tippfehler). Der bisherige Chef wird selbst zum
 * Verwalter, verliert also nicht schlagartig den Zugang.
 */
export function transferTeamOwnership(db: Db, team: TeamRow, newOwnerUserId: string): void {
	if (!isTeamAdmin(db, team.id, newOwnerUserId)) error(400, "Nur ein bestehender Verwalter kann Chef werden");
	db.transaction((tx) =>
		handOverTeam(tx, team.id, newOwnerUserId, { formerOwnerStaysAdmin: team.ownerUserId })
	);
}

/**
 * Den Besitz eines Teams auf einen seiner Verwalter umschreiben - der ist
 * danach Chef und steht nicht mehr doppelt in der Verwalterliste.
 * `formerOwnerStaysAdmin` setzt den bisherigen Chef als Verwalter ein; bei
 * einer Kontolöschung (account.ts) entfällt das, der geht ja.
 */
export function handOverTeam(
	db: DbLike,
	teamId: string,
	newOwnerUserId: string,
	opts: { formerOwnerStaysAdmin?: string } = {}
): void {
	db.update(teams).set({ ownerUserId: newOwnerUserId }).where(eq(teams.id, teamId)).run();
	db.delete(teamAdmins)
		.where(and(eq(teamAdmins.teamId, teamId), eq(teamAdmins.userId, newOwnerUserId)))
		.run();
	if (opts.formerOwnerStaysAdmin) {
		db.insert(teamAdmins)
			.values({ teamId, userId: opts.formerOwnerStaysAdmin, createdAt: Date.now() })
			.onConflictDoNothing()
			.run();
	}
}

/** Der aktuell gültige Verwalter-Link dieses Teams - oder null. */
export function activeAdminInvite(db: Db, teamId: string): TeamAdminInviteRow | null {
	return activeInvite(db, ADMIN_INVITES, teamId);
}

/** Wie rotateTeamInvite, nur fuer den Verwalter-Link - und mit Ablauf. */
export function rotateAdminInvite(db: Db, teamId: string): TeamAdminInviteRow {
	return rotateInvite(db, ADMIN_INVITES, teamId);
}

/** Team hinter einem gültigen Verwalter-Code - oder null. */
export function teamFromAdminInviteCode(db: DbLike, code: string): TeamRow | null {
	return teamFromCode(db, ADMIN_INVITES, code);
}

/**
 * Einen Verwalter-Link annehmen - braucht (anders als joinTeam) ein
 * angemeldetes Konto. Wer den Chef selbst einliest, aendert nichts (schon
 * automatisch Zugang). Mehrfaches Annehmen ist folgenlos (Unique-Index).
 */
export function joinTeamAsAdmin(db: Db, code: string, userId: string): TeamRow | null {
	const team = teamFromAdminInviteCode(db, code);
	if (!team) return null;
	if (team.ownerUserId === userId) return team;
	db.insert(teamAdmins)
		.values({ teamId: team.id, userId, createdAt: Date.now() })
		.onConflictDoNothing()
		.run();
	return team;
}

export interface TeamActivityRow extends TeamActivity {
	teamId: string;
}

export const MAX_TEAM_ACTIVITIES = 500;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

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
	if (items.length > MAX_TEAM_ACTIVITIES) error(400, "Zu viele Aktivitäten");
	const suppliedIds = items.map((it) => it.id).filter((id): id is string => !!id);
	if (suppliedIds.some((id) => id.length > 64)) error(400, "Ungültige Aktivitäts-Id");
	if (new Set(suppliedIds).size !== suppliedIds.length) error(400, "Eine Aktivität steht doppelt in der Liste");
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
		name: it.name.slice(0, TEAM_TEXT_MAX),
		isAbsence: it.isAbsence,
		sortOrder: it.sortOrder ?? i,
		color: it.color && HEX_COLOR.test(it.color) ? it.color : null,
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

/** Obergrenze je Bericht - ein echter Monat hat eine Handvoll Aktivitäten, nicht Tausende. */
export const MAX_TEAM_REPORT_ROWS = 200;

const REPORT_MONTH = /^(\d{4})-(\d{2})$/;

/**
 * Nur die Form `YYYY-MM` - zum Ansehen und Löschen. Dort muss auch ein alter
 * Monat gehen, anders als beim Anlegen (isPlausibleReportMonth).
 */
export function isReportMonthFormat(month: string): boolean {
	return REPORT_MONTH.test(month);
}

/**
 * Monatsangabe `YYYY-MM`, und zwar eine plausible: zwei Jahre zurück bis ein
 * Jahr voraus. Sonst wären je Mitglied eine Million Schlüssel (0000-00 …
 * 9999-99) frei, jeder eine eigene Zeile.
 */
export function isPlausibleReportMonth(month: string, now = new Date()): boolean {
	const m = REPORT_MONTH.exec(month);
	if (!m) return false;
	const year = Number(m[1]);
	const mon = Number(m[2]);
	const thisYear = now.getUTCFullYear();
	return mon >= 1 && mon <= 12 && year >= thisYear - 2 && year <= thisYear + 1;
}

export interface TeamReportPayload {
	rows: { name: string; hours: number; isAbsence: boolean }[];
	total: number;
	workHours: number;
	absenceHours: number;
}

const finiteHours = (v: unknown): number =>
	typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, 0), 10_000) : 0;

/**
 * Auf genau das zuschneiden, was die Team-Ansicht zeigt. Alles andere, was
 * ein Client mitschickt, landet nicht im Klartext auf dem Server - und die
 * Grösse je Bericht ist damit begrenzt. null, wenn es gar kein Bericht ist.
 */
export function sanitizeTeamReport(payload: unknown): TeamReportPayload | null {
	if (!payload || typeof payload !== "object") return null;
	const p = payload as Record<string, unknown>;
	if (!Array.isArray(p.rows)) return null;
	const rows = p.rows
		.filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
		.filter((r) => typeof r.name === "string")
		.slice(0, MAX_TEAM_REPORT_ROWS)
		.map((r) => ({
			name: (r.name as string).slice(0, TEAM_TEXT_MAX),
			hours: finiteHours(r.hours),
			isAbsence: r.isAbsence === true
		}));
	return {
		rows,
		total: finiteHours(p.total),
		workHours: finiteHours(p.workHours),
		absenceHours: finiteHours(p.absenceHours)
	};
}

/** Der Stand des Berichts eines Mitglieds für einen Monat - oder undefined. */
function findTeamReport(db: DbLike, memberId: string, month: string): { submittedAt: number } | undefined {
	return db
		.select({ submittedAt: teamReports.submittedAt })
		.from(teamReports)
		.where(and(eq(teamReports.memberId, memberId), eq(teamReports.month, month)))
		.get();
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
	payload: TeamReportPayload | null
): void {
	// Date.now() allein reicht nicht: unter Windows liegt die Aufloesung der
	// Systemuhr bei ~15 ms, zwei schnell aufeinanderfolgende Uploads koennten
	// also denselben Wert bekommen - und genau ueber diesen Wert erkennt
	// setTeamReportStatus einen zwischenzeitlich veralteten Stand.
	const existing = findTeamReport(db, memberId, month);
	const submittedAt = Math.max(Date.now(), (existing?.submittedAt ?? 0) + 1);
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
		if (!findTeamReport(db, memberId, month)) upsertTeamReport(db, teamId, memberId, month, null);
	} else {
		// Dieselbe Verwechslungsgefahr umgekehrt: zwischen Laden der Ansicht und
		// diesem Klick könnte ein echter Bericht eingetroffen sein. Stimmt der
		// mitgegebene Stand nicht mehr mit der Datenbank überein, nicht blind
		// darüberlöschen, sondern ablehnen - der Client lädt dann neu.
		const existing = findTeamReport(db, memberId, month);
		if (existing && expectedSubmittedAt !== undefined && existing.submittedAt !== expectedSubmittedAt) {
			error(409, "Der Bericht wurde inzwischen geändert");
		}
		db.delete(teamReports)
			.where(and(eq(teamReports.memberId, memberId), eq(teamReports.month, month)))
			.run();
	}
	return true;
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
