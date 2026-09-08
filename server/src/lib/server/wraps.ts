// Die verpackten Vault-Keys ablegen.
//
// Für den Server sind das undurchsichtige Bytes - er kann sie entgegennehmen,
// ohne etwas über die Daten dahinter zu erfahren. Genau deshalb können sie in
// derselben Transaktion entstehen wie der Passkey, zu dem sie gehören.
import { error } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import type { DbLike } from "./db/index";
import { credentials, keyWraps, users } from "./db/schema";
import { MAX_RECORD_BYTES } from "./config";
import { hashSecret } from "./auth";

// Die Kopplung zwischen zwei Geraeten legt ihre Verpackung nicht hier ab,
// sondern in pairings.wrapped_key (server/src/routes/api/pair/approve) -
// "device" gehoerte darum nie zu den Arten, die hier ankommen.
export type WrapKind = "recovery" | "passkey";

export interface WrapInput {
	kind: WrapKind;
	payload: string;
	/** Bei "passkey": zu welchem Passkey die Verpackung gehört. */
	credentialId?: string | null;
	/** Nur bei "recovery": unter welcher Kennung sie zu finden ist. */
	recoveryId?: string | null;
	/** Nur bei "recovery": der Nachweis, dass jemand den Vault-Key hat. */
	vaultProof?: string | null;
}

/** Aus einem JSON-Körper eine Verpackung lesen - oder verständlich ablehnen. */
export function readWrap(raw: unknown, kind: WrapKind): WrapInput {
	const d = raw as Record<string, unknown> | null;
	const payload = String(d?.payload ?? "");
	if (!payload || payload.length > MAX_RECORD_BYTES) {
		error(400, "Verpackung fehlt oder ist zu groß");
	}
	return {
		kind,
		payload,
		credentialId: d?.credentialId ? String(d.credentialId) : null,
		recoveryId: d?.recoveryId ? String(d.recoveryId) : null,
		vaultProof: d?.vaultProof ? String(d.vaultProof) : null
	};
}

/**
 * Eine Verpackung schreiben. MUSS in einer Transaktion laufen: bei "recovery"
 * hängen drei Schreibvorgänge aneinander, und ein Abbruch dazwischen liesse
 * die Kennung ins Leere zeigen.
 */
export function storeWrap(tx: DbLike, userId: string, wrap: WrapInput): string {
	// Beides oder keins: eines allein würde das andere überschreiben, und ein
	// Konto mit nur einem der beiden ist über die Phrase nicht mehr erreichbar.
	if (wrap.kind === "recovery" && Boolean(wrap.recoveryId) !== Boolean(wrap.vaultProof)) {
		error(400, "Kennung und Nachweis gehören zusammen");
	}

	// Je Passkey genau eine Verpackung - eine zweite wäre ein zweiter Weg zum
	// selben Schlüssel.
	if (wrap.kind === "passkey" && wrap.credentialId) {
		// Die Verpackung landet unter DIESEM Konto - der Passkey muss also auch
		// diesem Konto gehören, sonst liesse sich hier eine Verpackung auf einen
		// fremden/erratenen Passkey ablegen.
		const owned = tx
			.select({ id: credentials.id })
			.from(credentials)
			.where(and(eq(credentials.id, wrap.credentialId), eq(credentials.userId, userId)))
			.get();
		if (!owned) error(403, "Passkey gehört nicht zu diesem Konto");
		tx.delete(keyWraps)
			.where(and(eq(keyWraps.userId, userId), eq(keyWraps.credentialId, wrap.credentialId)))
			.run();
	}

	if (wrap.kind === "recovery") {
		// Kennung und Nachweis gehören zu DIESER Verpackung und wandern mit ihr.
		if (wrap.recoveryId && wrap.vaultProof) {
			// Dieselbe Kennung bei zwei Konten hiesse dieselbe Phrase bei zweien.
			const foreign = tx.select().from(users).where(eq(users.recoveryId, wrap.recoveryId)).get();
			if (foreign && foreign.id !== userId) error(409, "Diese Phrase ist bereits vergeben");
			// Der Nachweis nur als Hash: siehe schema.ts und hashSecret.
			tx.update(users)
				.set({ recoveryId: wrap.recoveryId, vaultProof: hashSecret(wrap.vaultProof) })
				.where(eq(users.id, userId))
				.run();
		}

		// Genau eine Phrase je Konto: eine neue macht die alte ungültig.
		tx.delete(keyWraps)
			.where(and(eq(keyWraps.userId, userId), eq(keyWraps.kind, "recovery")))
			.run();
	}

	const id = crypto.randomUUID();
	tx.insert(keyWraps)
		.values({
			id,
			userId,
			kind: wrap.kind,
			credentialId: wrap.credentialId ?? null,
			payload: wrap.payload,
			createdAt: Date.now()
		})
		.run();
	return id;
}
