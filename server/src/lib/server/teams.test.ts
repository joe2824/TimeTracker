// Team, Einladungslink, Beitritt, Roster - ohne den Weg über eine Route.
import { beforeEach, describe, expect, it } from "vitest";
import { type Db } from "./db/index";
import { ANNA, BODO, freshDb } from "./testing/fixtures";
import {
	activeTeamInvite,
	createTeam,
	joinTeam,
	listTeamMembers,
	listTeams,
	requireOwnTeam,
	revokeTeamMember,
	rotateTeamInvite,
	teamFromInviteCode,
	teamMemberFromToken
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
});
