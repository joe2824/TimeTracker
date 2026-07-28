import { describe, expect, it } from "vitest";
import { changedSettingKeys } from "./settingsSync";
import { defaultSettings, type Settings } from "./types";

const s = (patch: Partial<Settings> = {}): Settings => ({ ...defaultSettings, ...patch });

describe("changedSettingKeys", () => {
	it("findet nichts, wenn sich nichts geaendert hat", () => {
		expect(changedSettingKeys(s(), s()).size).toBe(0);
	});

	it("meldet die Adresse der Vorgesetzten, wenn der Assistent sie eingetragen hat", () => {
		// Der Fall aus dem Willkommens-Assistenten: die Einstellungs-Seite steht
		// bereits mit leeren Feldern da und muss diesen Wert nachziehen.
		const changed = changedSettingKeys(s(), s({ bossEmail: "chef@firma.de" }));
		expect([...changed]).toEqual(["bossEmail"]);
	});

	it("meldet mehrere Felder auf einmal", () => {
		const changed = changedSettingKeys(
			s(),
			s({ bossEmail: "chef@firma.de", senderName: "Max", hoursPerDay: 8 })
		);
		expect(changed).toEqual(new Set(["bossEmail", "senderName", "hoursPerDay"]));
	});

	it("vergleicht Listen inhaltlich, nicht nach Identitaet", () => {
		// reminderTimes/workdays werden bei jedem Speichern neu aufgebaut – nach
		// Identitaet waeren sie immer "geaendert" und ueberschrieben dann jedes Mal
		// eine gerade getippte Eingabe.
		expect(changedSettingKeys(s(), s({ reminderTimes: ["14:00"] })).size).toBe(0);
		expect(changedSettingKeys(s(), s({ workdays: [1, 2, 3, 4, 5] })).size).toBe(0);
		expect([...changedSettingKeys(s(), s({ reminderTimes: ["09:00"] }))]).toEqual([
			"reminderTimes"
		]);
		expect([...changedSettingKeys(s(), s({ workdays: [1, 2, 3, 4, 5, 6] }))]).toEqual(["workdays"]);
	});

	it("unterscheidet false von 0 und leeren Text", () => {
		expect([...changedSettingKeys(s({ statsEnabled: true }), s({ statsEnabled: false }))]).toEqual([
			"statsEnabled"
		]);
		expect([...changedSettingKeys(s({ idleThresholdMin: 10 }), s({ idleThresholdMin: 0 }))]).toEqual(
			["idleThresholdMin"]
		);
		expect([...changedSettingKeys(s({ senderName: "Max" }), s({ senderName: "" }))]).toEqual([
			"senderName"
		]);
	});
});
