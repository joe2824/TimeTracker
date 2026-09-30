import { describe, expect, it } from "vitest";
import { createSerialQueue } from "./utils";

describe("createSerialQueue", () => {
	it("startet den nächsten Vorgang erst nach dem vorigen", async () => {
		const serial = createSerialQueue();
		const order: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const first = serial(async () => {
			await gate;
			order.push("erster");
		});
		const second = serial(async () => {
			order.push("zweiter");
			return 2;
		});
		await Promise.resolve();
		expect(order).toEqual([]);
		release();
		expect(await second).toBe(2);
		await first;
		expect(order).toEqual(["erster", "zweiter"]);
	});

	it("ein Fehlschlag geht an seinen Aufrufer und hält die Schlange nicht an", async () => {
		const serial = createSerialQueue();
		const failing = serial(async () => {
			throw new Error("kaputt");
		});
		const after = serial(async () => "weiter");
		await expect(failing).rejects.toThrow("kaputt");
		expect(await after).toBe("weiter");
	});
});
