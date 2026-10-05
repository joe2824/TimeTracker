// Datensätze feldweise zusammenführen.
//
// Als Ganzes entschieden, gewänne jede Kleinigkeit - ein Umsortieren, das
// tägliche „heute aktiv" - samt aller übrigen, womöglich veralteten Felder des
// schreibenden Geräts. Darum trägt jedes Feld (oder jede Feldgruppe) einen
// eigenen Stempel, und je Feld gilt die jüngere Änderung.
import type { SyncMeta } from "../types";
import { stableStringify } from "../utils";

/** Wann welches Feld zuletzt geändert wurde (Epoch-ms der schreibenden Uhr). */
export type FieldStamps = Record<string, number>;

export type FieldStamped = SyncMeta;

export interface FieldRules {
	/** Was ein fehlendes Feld bedeutet - bei den Einstellungen die Voreinstellung. */
	defaults?: object;
	/** Felder, die nur gemeinsam gelten; gestempelt unter dem ersten Namen. */
	groups?: readonly (readonly string[])[];
}

/** Beginn und Ende stammen immer vom selben Gerät - sonst entstünde ein Lauf, den niemand erfasst hat. */
export const ENTRY_FIELDS: FieldRules = { groups: [["startTs", "endTs", "autoEnded"]] };

export const ACTIVITY_FIELDS: FieldRules = {};

const NOT_A_FIELD = new Set(["updatedAt", "rev", "deviceId", "id", "fieldUpdatedAt", "deletedAt"]);

type Loose = Record<string, unknown>;

/** Die Stempel-Schlüssel samt ihrer Felder, über alle genannten Stände. */
function slotsOf(rules: FieldRules, ...sides: object[]): Map<string, string[]> {
	const slots = new Map<string, string[]>();
	for (const side of sides) {
		for (const key of Object.keys(side)) {
			if (NOT_A_FIELD.has(key)) continue;
			const group = rules.groups?.find((g) => g.includes(key));
			const slot = group ? group[0] : key;
			if (!slots.has(slot)) slots.set(slot, group ? [...group] : [key]);
		}
	}
	return slots;
}

/**
 * Wann ein Feld zuletzt geändert wurde.
 *
 * Ein Stand ohne Feldstempel (ältere Fassung) gibt jedem Feld die Zeit des
 * Datensatzes; ein Feld, das dort fehlt, ist älter als jede Änderung.
 */
function stampOf(s: FieldStamped, slot: string, keys: string[]): number {
	if (s.fieldUpdatedAt) return s.fieldUpdatedAt[slot] ?? 0;
	return keys.some((k) => Object.hasOwn(s, k)) ? (s.updatedAt ?? 0) : 0;
}

function valuesOf(s: object, keys: string[], rules: FieldRules): string {
	const defaults = (rules.defaults ?? {}) as Loose;
	return stableStringify(keys.map((k) => (Object.hasOwn(s, k) ? (s as Loose)[k] : defaults[k])));
}

/** Wer gewinnt, wenn der Datensatz als Ganzes entscheidet. */
export function pickWinner<T extends SyncMeta>(local: T, remote: T): "local" | "remote" | "equal" {
	const l = local.updatedAt ?? 0;
	const r = remote.updatedAt ?? 0;
	if (l > r) return "local";
	if (r > l) return "remote";
	const ld = local.deviceId ?? "";
	const rd = remote.deviceId ?? "";
	if (ld === rd) return "equal";
	return ld > rd ? "local" : "remote";
}

/**
 * Die Feldstempel für einen Schreibvorgang: geänderte Felder bekommen `now`,
 * die übrigen behalten ihren. Bringt `after` für ein Feld einen jüngeren
 * Stempel mit, bleibt der - so legt der Abgleich Zusammengeführtes ab.
 */
export function stampFields<T extends FieldStamped>(
	before: T | null,
	after: T,
	now: number,
	rules: FieldRules
): T {
	const prior = before ?? ({} as T);
	const stamps: FieldStamps = {};
	for (const [slot, keys] of slotsOf(rules, prior, after)) {
		const old = stampOf(prior, slot, keys);
		const given = after.fieldUpdatedAt?.[slot] ?? 0;
		if (given > old) stamps[slot] = given;
		else if (valuesOf(prior, keys, rules) !== valuesOf(after, keys, rules)) stamps[slot] = now;
		else if (old > 0) stamps[slot] = old;
	}
	return { ...after, fieldUpdatedAt: stamps };
}

/**
 * Zwei Stände feldweise zusammenführen; die Fassung ist die des Servers
 * (`remote`), damit ein Hochladen danach auf ihr aufsetzt.
 *
 * Gleich alt und doch verschieden sind Felder nur zwischen Ständen ohne
 * Feldstempel - dort entscheidet der Datensatz als Ganzes, wie bisher.
 */
export function mergeFields<T extends FieldStamped>(local: T, remote: T, rules: FieldRules): T {
	const whole = pickWinner(local, remote) === "local" ? local : remote;
	const out = { ...remote } as Loose;
	const stamps: FieldStamps = {};
	for (const [slot, keys] of slotsOf(rules, local, remote)) {
		const l = stampOf(local, slot, keys);
		const r = stampOf(remote, slot, keys);
		const from = (l > r ? local : r > l ? remote : whole) as Loose;
		for (const k of keys) {
			if (Object.hasOwn(from, k)) out[k] = from[k];
			else delete out[k];
		}
		if (Math.max(l, r) > 0) stamps[slot] = Math.max(l, r);
	}
	// Ohne Stempel auf beiden Seiten bleibt es bei der alten Form: sonst ginge
	// jeder Datensatz aus einer älteren Fassung allein deshalb erneut hinauf.
	if (local.fieldUpdatedAt || remote.fieldUpdatedAt) out.fieldUpdatedAt = stamps;
	else delete out.fieldUpdatedAt;
	const newer = (local.updatedAt ?? 0) > (remote.updatedAt ?? 0) ? local : remote;
	return { ...(out as T), updatedAt: newer.updatedAt, deviceId: newer.deviceId, rev: remote.rev };
}

/** Ob zwei Stände inhaltlich gleich sind - Fassung, Zeit und Gerät außen vor. */
export function sameFields(a: object, b: object): boolean {
	const content = (s: object) =>
		Object.fromEntries(
			Object.entries(s).filter(
				([k, v]) => k !== "id" && k !== "updatedAt" && k !== "rev" && k !== "deviceId" && v !== undefined
			)
		);
	return stableStringify(content(a)) === stableStringify(content(b));
}

/**
 * Ob beim Zusammenführen eine eigene Änderung unterlegen ist: ein Feld aus dem
 * letzten eigenen Schreibvorgang, das jetzt anders lautet.
 */
export function lostLocalField<T extends FieldStamped>(local: T, merged: T, rules: FieldRules): boolean {
	if (local.updatedAt === undefined) return false;
	for (const [slot, keys] of slotsOf(rules, local)) {
		if (stampOf(local, slot, keys) !== local.updatedAt) continue;
		if (valuesOf(local, keys, rules) !== valuesOf(merged, keys, rules)) return true;
	}
	return false;
}

/**
 * Was die App an einem Datensatz geändert hat, auf den Stand der Platte legen.
 *
 * `known` ist, was die App gelesen hat, `ours` ihr jetziger Stand, `onDisk`
 * die Platte. Nur die Felder, die die App angefasst hat, kommen von ihr - der
 * Rest, etwa eine inzwischen eingespielte Änderung eines anderen Geräts, bleibt.
 */
export function overlayTouched<T extends object>(known: T, ours: T, onDisk: T, rules: FieldRules): T {
	const out = { ...onDisk } as Loose;
	for (const [, keys] of slotsOf(rules, known, ours)) {
		if (valuesOf(known, keys, rules) === valuesOf(ours, keys, rules)) continue;
		for (const k of keys) {
			if (Object.hasOwn(ours, k)) out[k] = (ours as Loose)[k];
			else delete out[k];
		}
	}
	// Die Spuren bringt die jüngere Seite mit: schreibt der Abgleich sein
	// Ergebnis, gelten seine Fassung und Feldstempel, sonst die der Platte.
	const o = ours as FieldStamped;
	const d = onDisk as FieldStamped;
	if ((o.updatedAt ?? 0) >= (d.updatedAt ?? 0)) {
		for (const k of ["updatedAt", "deviceId", "fieldUpdatedAt"] as const) {
			if (o[k] !== undefined) out[k] = o[k];
			else delete out[k];
		}
	}
	if (o.rev !== undefined || d.rev !== undefined) out.rev = Math.max(o.rev ?? 0, d.rev ?? 0);
	return out as T;
}

/** Ob die App an einem Datensatz überhaupt ein Feld angefasst hat. */
export function touchedAny<T extends object>(known: T, ours: T, rules: FieldRules): boolean {
	for (const [, keys] of slotsOf(rules, known, ours)) {
		if (valuesOf(known, keys, rules) !== valuesOf(ours, keys, rules)) return true;
	}
	return false;
}
