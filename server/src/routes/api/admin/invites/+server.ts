// Einladungen verwalten - nur fuer Verwalter.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	envInvitesDeaktiviert,
	erstelleInvite,
	istVerwalter,
	listeInvites,
	setzeEnvInvitesDeaktiviert,
	zieheInviteZurueck
} from "$lib/server/invites";
import { INVITE_CODES } from "$lib/server/config";

/** Verwalter sein - und zwar frisch geprueft, nicht aus einem Token geglaubt. */
function nurVerwalter(locals: App.Locals): string {
	if (!locals.userId) error(401, "Nicht angemeldet");
	if (!istVerwalter(locals.db, locals.userId)) error(403, "Keine Berechtigung");
	return locals.userId;
}

export const GET: RequestHandler = ({ locals }) => {
	nurVerwalter(locals);
	return json({
		invites: listeInvites(locals.db),
		envInvitesConfigured: INVITE_CODES.length > 0,
		envInvitesActive: INVITE_CODES.length > 0 && !envInvitesDeaktiviert(locals.db)
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const wer = nurVerwalter(locals);
	const body = await request.json().catch(() => null);

	const tage = Number(body?.gueltigTage ?? 0);
	// Eine Frist ist die Voreinstellung des Verwalters, nicht des Servers: ein
	// Code ohne Frist ist manchmal genau richtig (Familie), meistens aber nicht.
	const expiresAt = tage > 0 ? Date.now() + tage * 86_400_000 : null;

	const zeile = erstelleInvite(locals.db, wer, {
		note: typeof body?.note === "string" ? body.note : undefined,
		expiresAt
	});
	return json(zeile, { status: 201 });
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
	nurVerwalter(locals);
	const body = await request.json().catch(() => null);
	const active = Boolean(body?.active);
	setzeEnvInvitesDeaktiviert(locals.db, !active);
	return json({
		ok: true,
		envInvitesActive: INVITE_CODES.length > 0 && active
	});
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
	nurVerwalter(locals);
	const body = await request.json().catch(() => null);
	const code = String(body?.code ?? "");
	if (!zieheInviteZurueck(locals.db, code)) {
		error(404, "Code unbekannt, schon benutzt oder bereits zurückgezogen");
	}
	return json({ ok: true });
};
