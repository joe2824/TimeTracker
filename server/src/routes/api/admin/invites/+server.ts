// Einladungen verwalten - nur fuer Verwalter.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	envInvitesDisabled,
	createInvite,
	isRegistrationOpen,
	isAdminUser,
	listInvites,
	setEnvInvitesDisabled,
	setRegistrationOpen,
	revokeInvite
} from "$lib/server/invites";
import { INVITE_CODES } from "$lib/server/config";

/** Verwalter sein - und zwar frisch geprueft, nicht aus einem Token geglaubt. */
function adminOnly(locals: App.Locals): string {
	if (!locals.userId) error(401, "Nicht angemeldet");
	if (!isAdminUser(locals.db, locals.userId)) error(403, "Keine Berechtigung");
	return locals.userId;
}

export const GET: RequestHandler = ({ locals }) => {
	adminOnly(locals);
	return json({
		invites: listInvites(locals.db),
		envInvitesConfigured: INVITE_CODES.length > 0,
		envInvitesActive: INVITE_CODES.length > 0 && !envInvitesDisabled(locals.db),
		openRegistration: isRegistrationOpen(locals.db)
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const who = adminOnly(locals);
	const body = await request.json().catch(() => null);

	const days = Number(body?.validDays ?? 0);
	// Eine Frist ist die Voreinstellung des Verwalters, nicht des Servers: ein
	// Code ohne Frist ist manchmal genau richtig (Familie), meistens aber nicht.
	const expiresAt = days > 0 ? Date.now() + days * 86_400_000 : null;

	const rowText = createInvite(locals.db, who, {
		note: typeof body?.note === "string" ? body.note : undefined,
		expiresAt
	});
	return json(rowText, { status: 201 });
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
	adminOnly(locals);
	const body = await request.json().catch(() => null);
	if (typeof body?.openRegistration === "boolean") {
		setRegistrationOpen(locals.db, body.openRegistration);
	}
	if (typeof body?.active === "boolean") {
		setEnvInvitesDisabled(locals.db, !body.active);
	}
	return json({
		ok: true,
		envInvitesActive: INVITE_CODES.length > 0 && !envInvitesDisabled(locals.db),
		openRegistration: isRegistrationOpen(locals.db)
	});
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
	adminOnly(locals);
	const body = await request.json().catch(() => null);
	const code = String(body?.code ?? "");
	if (!revokeInvite(locals.db, code)) {
		error(404, "Code unbekannt, schon benutzt oder bereits zurückgezogen");
	}
	return json({ ok: true });
};
