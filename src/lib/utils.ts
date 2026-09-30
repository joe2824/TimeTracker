import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };

export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, "child"> : T;

export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, "children"> : T;

export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;

/** JSON mit rekursiv sortierten Schlüsseln - für Inhaltsvergleiche unabhängig von der Feldreihenfolge. */
export function stableStringify(value: unknown): string {
	return JSON.stringify(value, (_k, v: unknown) =>
		v && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: v
	);
}

/** Führt übergebene Vorgänge nacheinander aus. */
export type SerialQueue = <T>(op: () => Promise<T>) => Promise<T>;

/**
 * Eine Schlange, in der jeder Vorgang erst startet, wenn der vorige fertig ist.
 * Ein gescheiterter Vorgang hält die Schlange nicht an: seinen Fehler bekommt
 * nur, wer ihn eingereiht hat.
 */
export function createSerialQueue(): SerialQueue {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(op: () => Promise<T>): Promise<T> => {
		const next = tail.then(op, op);
		tail = next.catch(() => {});
		return next;
	};
}
