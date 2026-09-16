// Team, Einladungslink, Beitritt, Roster - ohne den Weg über eine Route.
import { beforeEach, describe, expect, it } from "vitest";
import { type Db } from "./db/index";
import { ANNA, BODO, freshDb } from "./testing/fixtures";
import {
	activeAdminInvite,
	activeTeamInvite,
	createTeam,
	deleteTeam,
	joinTeam,
	joinTeamAsAdmin,
	listTeamActivities,
	listTeamAdmins,
	listTeamMembers,
	listTeamReports,
	listTeams,
	removeTeamAdmin,
	requireOwnTeam,
	requireTeamAccess,
	requireTeamMember,
	revokeTeamMember,
	rotateAdminInvite,
	rotateTeamInvite,
	setTeamActivities,
	setTeamReportStatus,
	teamFromAdminInviteCode,
	teamFromInviteCode,
	teamMemberFromToken,
	transferTeamOwnership,
	upsertTeamReport
} from "./teams";

let db: Db;

beforeEach(() => {
	db = freshDb();
});

describe("createTeam / listTeams", () => {
	it("gehört dem anlegenden Konto und taucht in dessen Liste auf", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		expect(listTeams(db, ANNA).map((t) => t.id)).toEqual([team.id]);
		expect(listTeams(db, BODO)).toEqual([]);
	});

	it("ein Chef kann mehrere Teams führen", () => {
		createTeam(db, ANNA, "Vertrieb");
		createTeam(db, ANNA, "Support");
		expect(listTeams(db, ANNA)).toHaveLength(2);
	});

	it("zeigt eigene Teams als 'owner', als Verwalter beigetretene als 'admin'", () => {
		const own = createTeam(db, ANNA, "Vertrieb");
		const other = createTeam(db, BODO, "Support");
		const invite = rotateAdminInvite(db, other.id);
		joinTeamAsAdmin(db, invite.code, ANNA);

		const list = listTeams(db, ANNA);
		expect(list.find((t) => t.id === own.id)?.role).toBe("owner");
		expect(list.find((t) => t.id === other.id)?.role).toBe("admin");
	});
});

describe("requireOwnTeam", () => {
	it("wirft 404 für ein fremdes oder unbekanntes Team", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		expect(() => requireOwnTeam(db, BODO, team.id)).toThrow();
		expect(() => requireOwnTeam(db, ANNA, "unbekannt")).toThrow();
	});

	it("gibt das Team zurück, wenn es dem Konto gehört", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		expect(requireOwnTeam(db, ANNA, team.id).id).toBe(team.id);
	});
});

describe("deleteTeam", () => {
	it("nimmt Mitglieder, Aktivitäten und Einladung per Fremdschlüssel-Kaskade mit", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const invite = rotateTeamInvite(db, team.id);
		joinTeam(db, invite.code, "Anna Meier");
		setTeamActivities(db, team.id, [
			{ name: "Projekt A", isAbsence: false, sortOrder: 0, archived: false }
		]);
		expect(listTeamMembers(db, team.id)).toHaveLength(1);
		expect(listTeamActivities(db, team.id)).toHaveLength(1);

		deleteTeam(db, team.id);

		expect(listTeams(db, ANNA)).toEqual([]);
		expect(listTeamMembers(db, team.id)).toEqual([]);
		expect(listTeamActivities(db, team.id)).toEqual([]);
		expect(activeTeamInvite(db, team.id)).toBeNull();
	});

	it("ein unbekanntes Team zu löschen ist folgenlos", () => {
		expect(() => deleteTeam(db, "unbekannt")).not.toThrow();
	});
});

describe("rotateTeamInvite", () => {
	it("erzeugt einen gültigen Link und widerruft den vorigen", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const first = rotateTeamInvite(db, team.id);
		expect(activeTeamInvite(db, team.id)?.code).toBe(first.code);

		const second = rotateTeamInvite(db, team.id);
		expect(second.code).not.toBe(first.code);
		expect(activeTeamInvite(db, team.id)?.code).toBe(second.code);
		// Der alte Code führt nicht mehr zum Team.
		expect(teamFromInviteCode(db, first.code)).toBeNull();
		expect(teamFromInviteCode(db, second.code)?.id).toBe(team.id);
	});

	it("ohne Link gibt es nichts Aktives", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		expect(activeTeamInvite(db, team.id)).toBeNull();
	});
});

describe("joinTeam", () => {
	it("legt bei jedem Aufruf eine NEUE Mitgliedszeile an - rein link-getrieben", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const invite = rotateTeamInvite(db, team.id);

		const first = joinTeam(db, invite.code, "Anna Meier");
		const second = joinTeam(db, invite.code, "Anna Meier");
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(first!.teamMemberId).not.toBe(second!.teamMemberId);
		expect(first!.token).not.toBe(second!.token);
		expect(listTeamMembers(db, team.id)).toHaveLength(2);
	});

	it("liefert null für einen unbekannten Code", () => {
		expect(joinTeam(db, "UNBEKANNT-CODE", "Anna Meier")).toBeNull();
	});

	it("die E-Mail ist freiwillig - fehlt sie, steht null im Roster", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const invite = rotateTeamInvite(db, team.id);
		joinTeam(db, invite.code, "Anna Meier", "anna@firma.de");
		joinTeam(db, invite.code, "Bodo Schmidt");
		const roster = listTeamMembers(db, team.id).sort((a, b) => a.name.localeCompare(b.name));
		expect(roster[0]).toMatchObject({ name: "Anna Meier", email: "anna@firma.de" });
		expect(roster[1]).toMatchObject({ name: "Bodo Schmidt", email: null });
	});

	it("liefert null für einen widerrufenen Code", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const invite = rotateTeamInvite(db, team.id);
		rotateTeamInvite(db, team.id); // widerruft `invite`
		expect(joinTeam(db, invite.code, "Anna Meier")).toBeNull();
	});

	it("gibt einen Namen ohne Eingabe nicht leer weiter", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const invite = rotateTeamInvite(db, team.id);
		joinTeam(db, invite.code, "");
		expect(listTeamMembers(db, team.id)[0].name).toBe("Ohne Namen");
	});
});

describe("teamMemberFromToken", () => {
	it("findet das Mitglied und aktualisiert lastSeenAt", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const invite = rotateTeamInvite(db, team.id);
		const joined = joinTeam(db, invite.code, "Anna Meier")!;

		const before = listTeamMembers(db, team.id)[0].lastSeenAt;
		const auth = teamMemberFromToken(db, joined.token);
		expect(auth).toEqual({ teamMemberId: joined.teamMemberId, teamId: team.id });
		expect(listTeamMembers(db, team.id)[0].lastSeenAt).not.toBe(before);
	});

	it("liefert null für ein falsches oder widerrufenes Token", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const invite = rotateTeamInvite(db, team.id);
		const joined = joinTeam(db, invite.code, "Anna Meier")!;

		expect(teamMemberFromToken(db, "falsches-token")).toBeNull();
		revokeTeamMember(db, team.id, joined.teamMemberId);
		expect(teamMemberFromToken(db, joined.token)).toBeNull();
	});
});

describe("revokeTeamMember", () => {
	it("entfernt nur innerhalb des richtigen Teams", () => {
		const teamA = createTeam(db, ANNA, "Vertrieb");
		const teamB = createTeam(db, ANNA, "Support");
		const invite = rotateTeamInvite(db, teamA.id);
		const joined = joinTeam(db, invite.code, "Anna Meier")!;

		expect(revokeTeamMember(db, teamB.id, joined.teamMemberId)).toBe(false);
		expect(revokeTeamMember(db, teamA.id, joined.teamMemberId)).toBe(true);
		expect(revokeTeamMember(db, teamA.id, joined.teamMemberId)).toBe(false);
	});

	it("ein hinausgeworfenes Mitglied bleibt aus dem Roster - kommt nicht nach dem naechsten Laden zurueck", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const invite = rotateTeamInvite(db, team.id);
		const staying = joinTeam(db, invite.code, "Anna Meier")!;
		const kicked = joinTeam(db, invite.code, "Bodo Schmidt")!;

		revokeTeamMember(db, team.id, kicked.teamMemberId);

		const roster = listTeamMembers(db, team.id);
		expect(roster.map((m) => m.id)).toEqual([staying.teamMemberId]);
	});
});

describe("requireTeamMember", () => {
	it("wirft ohne Team-Zugang, gibt sonst die teamId zurück", () => {
		expect(() => requireTeamMember({ teamMemberId: null, teamId: null })).toThrow();
		expect(() => requireTeamMember({ teamMemberId: "m1", teamId: null })).toThrow();
		expect(requireTeamMember({ teamMemberId: "m1", teamId: "t1" })).toBe("t1");
	});
});

describe("Verwalter (rotateAdminInvite / joinTeamAsAdmin / requireTeamAccess)", () => {
	it("requireTeamAccess laesst Chef und Verwalter durch, wirft sonst 404", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		expect(requireTeamAccess(db, ANNA, team.id).id).toBe(team.id);
		expect(() => requireTeamAccess(db, BODO, team.id)).toThrow();

		const invite = rotateAdminInvite(db, team.id);
		joinTeamAsAdmin(db, invite.code, BODO);
		expect(requireTeamAccess(db, BODO, team.id).id).toBe(team.id);
	});

	it("macht aus einem Konto einen Verwalter, sichtbar in listTeamAdmins", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const invite = rotateAdminInvite(db, team.id);
		expect(activeAdminInvite(db, team.id)?.code).toBe(invite.code);

		expect(joinTeamAsAdmin(db, invite.code, BODO)?.id).toBe(team.id);
		expect(listTeamAdmins(db, team.id).map((a) => a.userId)).toEqual([BODO]);
	});

	it("wie rotateTeamInvite: der alte Code fuehrt nach einer Erneuerung nicht mehr zum Team", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const first = rotateAdminInvite(db, team.id);
		rotateAdminInvite(db, team.id);
		expect(teamFromAdminInviteCode(db, first.code)).toBeNull();
	});

	it("ein unbekannter Code liefert null, statt einen Verwalter anzulegen", () => {
		expect(joinTeamAsAdmin(db, "UNBEKANNT-CODE", BODO)).toBeNull();
	});

	it("der Chef selbst einzulesen aendert nichts - er steht schon per ownerUserId drin", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const invite = rotateAdminInvite(db, team.id);
		expect(joinTeamAsAdmin(db, invite.code, ANNA)?.id).toBe(team.id);
		expect(listTeamAdmins(db, team.id)).toEqual([]);
	});

	it("zweimal annehmen bleibt folgenlos (Unique-Index statt Fehler)", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const invite = rotateAdminInvite(db, team.id);
		joinTeamAsAdmin(db, invite.code, BODO);
		expect(() => joinTeamAsAdmin(db, invite.code, BODO)).not.toThrow();
		expect(listTeamAdmins(db, team.id)).toHaveLength(1);
	});

	it("removeTeamAdmin nimmt den Zugang wieder zurueck", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const invite = rotateAdminInvite(db, team.id);
		joinTeamAsAdmin(db, invite.code, BODO);

		removeTeamAdmin(db, team.id, BODO);

		expect(listTeamAdmins(db, team.id)).toEqual([]);
		expect(() => requireTeamAccess(db, BODO, team.id)).toThrow();
	});
});

describe("transferTeamOwnership", () => {
	it("wirft, wenn das Ziel noch kein Verwalter dieses Teams ist", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		expect(() => transferTeamOwnership(db, team, BODO)).toThrow();
	});

	it("macht das Ziel zum Chef und den bisherigen Chef zum Verwalter", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const invite = rotateAdminInvite(db, team.id);
		joinTeamAsAdmin(db, invite.code, BODO);

		transferTeamOwnership(db, team, BODO);

		expect(requireOwnTeam(db, BODO, team.id).ownerUserId).toBe(BODO);
		expect(() => requireOwnTeam(db, ANNA, team.id)).toThrow();
		// weiterhin Zugriff, aber jetzt als Verwalter statt als Chef
		expect(requireTeamAccess(db, ANNA, team.id).id).toBe(team.id);
		expect(listTeamAdmins(db, team.id).map((a) => a.userId)).toEqual([ANNA]);
	});
});

describe("setTeamActivities / listTeamActivities", () => {
	it("ersetzt die Liste vollständig, sortiert wie übergeben", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		setTeamActivities(db, team.id, [
			{ name: "Projekt A", isAbsence: false, sortOrder: 1, archived: false },
			{ name: "Projekt B", isAbsence: false, sortOrder: 0, archived: false }
		]);
		expect(listTeamActivities(db, team.id).map((a) => a.name)).toEqual(["Projekt B", "Projekt A"]);

		// Ein zweiter Speichervorgang ERSETZT, statt anzuhängen.
		setTeamActivities(db, team.id, [{ name: "Nur noch die", isAbsence: false, sortOrder: 0, archived: false }]);
		expect(listTeamActivities(db, team.id).map((a) => a.name)).toEqual(["Nur noch die"]);
	});

	it("behält eine übergebene Id, erfindet sonst eine neue", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const [row] = setTeamActivities(db, team.id, [
			{ id: "eigene-id", name: "Projekt A", isAbsence: false, sortOrder: 0, archived: false }
		]);
		expect(row.id).toBe("eigene-id");

		const [fresh] = setTeamActivities(db, team.id, [
			{ name: "Projekt B", isAbsence: false, sortOrder: 0, archived: false }
		]);
		expect(fresh.id).toBeTruthy();
		expect(fresh.id).not.toBe("eigene-id");
	});

	it("betrifft nur das eigene Team", () => {
		const teamA = createTeam(db, ANNA, "Vertrieb");
		const teamB = createTeam(db, ANNA, "Support");
		setTeamActivities(db, teamA.id, [{ name: "A", isAbsence: false, sortOrder: 0, archived: false }]);
		setTeamActivities(db, teamB.id, [{ name: "B", isAbsence: false, sortOrder: 0, archived: false }]);
		expect(listTeamActivities(db, teamA.id).map((a) => a.name)).toEqual(["A"]);
		expect(listTeamActivities(db, teamB.id).map((a) => a.name)).toEqual(["B"]);
	});

	it("lehnt eine Id ab, die einem anderen Team gehört - statt sie zu überschreiben oder abzustürzen", () => {
		const teamA = createTeam(db, ANNA, "Vertrieb");
		const teamB = createTeam(db, ANNA, "Support");
		const [rowA] = setTeamActivities(db, teamA.id, [
			{ name: "A", isAbsence: false, sortOrder: 0, archived: false }
		]);

		expect(() =>
			setTeamActivities(db, teamB.id, [
				{ id: rowA.id, name: "Uebernommen", isAbsence: false, sortOrder: 0, archived: false }
			])
		).toThrow();

		// Team A's Zeile blieb unangetastet - kein stilles Ueberschreiben.
		expect(listTeamActivities(db, teamA.id)).toEqual([rowA]);
		expect(listTeamActivities(db, teamB.id)).toEqual([]);
	});

	it("lehnt einen veralteten erwarteten Stand ab - z.B. ein zweiter Tab des Chefs", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		setTeamActivities(db, team.id, [{ name: "A", isAbsence: false, sortOrder: 0, archived: false }]);

		expect(() =>
			setTeamActivities(
				db,
				team.id,
				[{ name: "B", isAbsence: false, sortOrder: 0, archived: false }],
				0 // Stand, den ein zweiter Tab noch vor "A" geladen hatte.
			)
		).toThrow();

		// Der zuerst gespeicherte Stand blieb unangetastet.
		expect(listTeamActivities(db, team.id).map((a) => a.name)).toEqual(["A"]);
	});

	it("speichert, wenn der erwartete Stand noch aktuell ist", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		setTeamActivities(db, team.id, []);

		const rows = setTeamActivities(
			db,
			team.id,
			[{ name: "A", isAbsence: false, sortOrder: 0, archived: false }],
			0
		);

		expect(rows.map((a) => a.name)).toEqual(["A"]);
	});
});

describe("upsertTeamReport / listTeamReports", () => {
	function memberOf(teamId: string, name = "Anna Meier") {
		const invite = rotateTeamInvite(db, teamId);
		return joinTeam(db, invite.code, name)!;
	}

	it("zeigt fehlende Mitglieder als null, bis ein Bericht eingeht", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const member = memberOf(team.id);

		const before = listTeamReports(db, team.id, "2026-07");
		expect(before).toEqual([
			{
				memberId: member.teamMemberId,
				memberName: "Anna Meier",
				memberEmail: null,
				submittedAt: null,
				payload: null
			}
		]);

		upsertTeamReport(db, team.id, member.teamMemberId, "2026-07", { total: 40 });
		const after = listTeamReports(db, team.id, "2026-07");
		expect(after[0].submittedAt).not.toBeNull();
		expect(after[0].payload).toEqual({ total: 40 });
	});

	it("ein erneuter Versand desselben Monats ERSETZT, statt eine zweite Zeile anzulegen", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const member = memberOf(team.id);

		upsertTeamReport(db, team.id, member.teamMemberId, "2026-07", { total: 40 });
		const firstSubmittedAt = listTeamReports(db, team.id, "2026-07")[0].submittedAt;

		upsertTeamReport(db, team.id, member.teamMemberId, "2026-07", { total: 42 });
		const rows = listTeamReports(db, team.id, "2026-07");
		expect(rows).toHaveLength(1);
		expect(rows[0].payload).toEqual({ total: 42 });
		expect(rows[0].submittedAt).toBeGreaterThanOrEqual(firstSubmittedAt!);
	});

	it("betrifft nur den abgefragten Monat", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const member = memberOf(team.id);
		upsertTeamReport(db, team.id, member.teamMemberId, "2026-06", { total: 10 });

		expect(listTeamReports(db, team.id, "2026-07")[0].submittedAt).toBeNull();
		expect(listTeamReports(db, team.id, "2026-06")[0].submittedAt).not.toBeNull();
	});

	it("hoert auf, ein hinausgeworfenes Mitglied als fehlend zu fuehren", () => {
		// Sonst zielte "Fehlende erinnern" weiter auf jemanden, der laengst nicht
		// mehr im Team ist.
		const team = createTeam(db, ANNA, "Vertrieb");
		const kept = memberOf(team.id, "Anna Meier");
		const kicked = memberOf(team.id, "Bodo Schmidt");
		revokeTeamMember(db, team.id, kicked.teamMemberId);

		const reports = listTeamReports(db, team.id, "2026-07");
		expect(reports.map((r) => r.memberId)).toEqual([kept.teamMemberId]);
	});
});

describe("setTeamReportStatus", () => {
	function memberOf(teamId: string, name = "Anna Meier") {
		const invite = rotateTeamInvite(db, teamId);
		return joinTeam(db, invite.code, name)!;
	}

	it("markiert von Hand als gesendet - ohne Inhalt", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const member = memberOf(team.id);

		expect(setTeamReportStatus(db, team.id, member.teamMemberId, "2026-07", true)).toBe(true);

		const [status] = listTeamReports(db, team.id, "2026-07");
		expect(status.submittedAt).not.toBeNull();
		expect(status.payload).toBeNull();
	});

	it("nimmt eine Markierung zurueck - auch einen echten Upload", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const member = memberOf(team.id);
		upsertTeamReport(db, team.id, member.teamMemberId, "2026-07", { total: 40 });

		expect(setTeamReportStatus(db, team.id, member.teamMemberId, "2026-07", false)).toBe(true);

		expect(listTeamReports(db, team.id, "2026-07")[0].submittedAt).toBeNull();
	});

	it("liefert false fuer ein Mitglied, das nicht zu diesem Team gehoert", () => {
		const teamA = createTeam(db, ANNA, "Vertrieb");
		const teamB = createTeam(db, ANNA, "Support");
		const memberOfA = memberOf(teamA.id);

		expect(setTeamReportStatus(db, teamB.id, memberOfA.teamMemberId, "2026-07", true)).toBe(false);
		expect(listTeamReports(db, teamB.id, "2026-07")).toEqual([]);
	});

	it("lehnt das Zuruecknehmen ab, wenn zwischenzeitlich ein neuerer Bericht eintraf", () => {
		// Sonst koennte eine veraltete Ansicht einen inzwischen echten Upload
		// wegloeschen - siehe upsertTeamReport oben fuer den umgekehrten Fall.
		const team = createTeam(db, ANNA, "Vertrieb");
		const member = memberOf(team.id);
		upsertTeamReport(db, team.id, member.teamMemberId, "2026-07", { total: 40 });
		const staleSubmittedAt = listTeamReports(db, team.id, "2026-07")[0].submittedAt!;

		upsertTeamReport(db, team.id, member.teamMemberId, "2026-07", { total: 42 });

		expect(() =>
			setTeamReportStatus(db, team.id, member.teamMemberId, "2026-07", false, staleSubmittedAt)
		).toThrow();
		expect(listTeamReports(db, team.id, "2026-07")[0].payload).toEqual({ total: 42 });
	});

	it("nimmt zurueck, wenn der mitgegebene Stand noch aktuell ist", () => {
		const team = createTeam(db, ANNA, "Vertrieb");
		const member = memberOf(team.id);
		upsertTeamReport(db, team.id, member.teamMemberId, "2026-07", { total: 40 });
		const submittedAt = listTeamReports(db, team.id, "2026-07")[0].submittedAt!;

		expect(
			setTeamReportStatus(db, team.id, member.teamMemberId, "2026-07", false, submittedAt)
		).toBe(true);
		expect(listTeamReports(db, team.id, "2026-07")[0].submittedAt).toBeNull();
	});
});
