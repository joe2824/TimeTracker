// Was Routen gemeinsam aus einer Anfrage lesen und wie sie Fehler melden.
import { error } from "@sveltejs/kit";
import { SyncError } from "./sync";

/**
 * Den JSON-Körper lesen - null, wenn er fehlt oder kaputt ist. Die Routen
 * lesen Felder daraus mit `?.` und lehnen selbst ab, was fehlt.
 */
export async function readJson(request: Request): Promise<any> {
	return request.json().catch(() => null);
}

/** Einen SyncError als HTTP-Fehler weiterreichen, alles andere unverändert. */
export function rethrowSyncError(e: unknown): never {
	if (e instanceof SyncError) error(e.status, e.message);
	throw e;
}

/** Eine JSON-Fehlerantwort ausserhalb eines Route-Handlers (hooks.server.ts). */
export function jsonError(status: number, message: string, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify({ message }), {
		status,
		headers: { "content-type": "application/json", ...headers }
	});
}
