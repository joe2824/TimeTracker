import { describe, expect, it } from "vitest";
import { changedSettingKeys, formFromSettings, patchFrom, syncForm } from "./settingsSync";
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

describe("formFromSettings", () => {
	it("legt Zahlen als Text und Stunden als Uhrzeit ins Formular", () => {
		const form = formFromSettings(s({ hoursPerDay: 7.5, idleThresholdMin: 10, rounding: 0.5 }));
		expect(form.hoursPerDay).toBe("07:30");
		expect(form.idleThresholdMin).toBe("10");
		expect(form.rounding).toBe("0.5");
	});

	it("kopiert Listen, statt sie zu teilen", () => {
		const stored = s({ workdays: [1, 2], team: [{ id: "a", name: "Max", email: "m@f.de" }] });
		const form = formFromSettings(stored);
		form.workdays.push(6);
		form.team[0].name = "Moritz";
		expect(stored.workdays).toEqual([1, 2]);
		expect(stored.team[0].name).toBe("Max");
	});
});

describe("patchFrom", () => {
	it("rechnet Text zurueck in Zahlen und Stunden", () => {
		const form = formFromSettings(s());
		form.hoursPerDay = "8:00";
		form.idleThresholdMin = "15";
		expect(patchFrom(form, ["hoursPerDay", "idleThresholdMin"], s())).toEqual({
			hoursPerDay: 8,
			idleThresholdMin: 15
		});
	});

	it("faellt bei geleertem Feld auf den gespeicherten Wert zurueck", () => {
		// Ohne Speichern-Knopf ist das Pflicht: wer eine Vorlage zum Neutippen leert,
		// darf damit nicht den Standardtext festschreiben.
		const stored = s({ reportSubjectTemplate: "Bericht {month}", hoursPerDay: 7.5 });
		const form = formFromSettings(stored);
		form.reportSubjectTemplate = "   ";
		form.hoursPerDay = "";
		expect(patchFrom(form, ["reportSubjectTemplate", "hoursPerDay"], stored)).toEqual({
			reportSubjectTemplate: "Bericht {month}",
			hoursPerDay: 7.5
		});
		// und das Feld zeigt danach wieder den gueltigen Stand
		expect(form.hoursPerDay).toBe("07:30");
		expect(form.reportSubjectTemplate).toBe("Bericht {month}");
	});

	it("haelt Zahlen in ihren Grenzen", () => {
		const form = formFromSettings(s());
		form.reportReminderLeadDays = "40";
		form.idleThresholdMin = "-5";
		form.pomodoroBreakMin = "abc";
		expect(patchFrom(form, ["reportReminderLeadDays", "idleThresholdMin", "pomodoroBreakMin"], s())).toEqual({
			reportReminderLeadDays: 10,
			idleThresholdMin: 0,
			pomodoroBreakMin: 0
		});
	});

	it("raeumt Listen auf, ohne die Zeilen im Formular anzutasten", () => {
		// Eine gerade angelegte, noch leere Zeile darf nicht unter den Haenden
		// verschwinden – gespeichert wird sie trotzdem nicht.
		const form = formFromSettings(s());
		form.team = [
			{ id: "a", name: " Max ", email: " m@f.de " },
			{ id: "b", name: "", email: "" }
		];
		form.reminderTimes = ["09:00", "  "];
		const patch = patchFrom(form, ["team", "reminderTimes"], s());
		expect(patch.team).toEqual([{ id: "a", name: "Max", email: "m@f.de" }]);
		expect(patch.reminderTimes).toEqual(["09:00"]);
		expect(form.team).toHaveLength(2);
		expect(form.reminderTimes).toHaveLength(2);
	});

	it("kopiert Listen in den Patch, statt sie mit dem Formular zu teilen", () => {
		const form = formFromSettings(s());
		form.workdays = [5, 1];
		const patch = patchFrom(form, ["workdays"], s());
		expect(patch.workdays).toEqual([1, 5]);
		form.workdays.push(6);
		expect(patch.workdays).toEqual([1, 5]);
	});
});

describe("syncForm", () => {
	it("zieht nur geaenderte Schluessel nach", () => {
		const prev = s();
		const form = formFromSettings(prev);
		form.senderName = "gerade getippt";
		const next = s({ bossEmail: "chef@firma.de" });

		expect(syncForm(form, prev, next)).toBe(next);
		expect(form.bossEmail).toBe("chef@firma.de");
		// Die unbestaetigte Eingabe in einer anderen Karte bleibt stehen.
		expect(form.senderName).toBe("gerade getippt");
	});

	it("uebersetzt nachgezogene Werte ins Feldformat", () => {
		const prev = s();
		const form = formFromSettings(prev);
		syncForm(form, prev, s({ hoursPerDay: 8, idleThresholdMin: 20 }));
		expect(form.hoursPerDay).toBe("08:00");
		expect(form.idleThresholdMin).toBe("20");
	});
});
