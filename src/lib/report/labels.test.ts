import { describe, expect, it } from "vitest";
import { absenceLabel, dayFractionLabel } from "./labels";

describe("dayFractionLabel", () => {
	it("nennt halbe und ganze Tage", () => {
		expect(dayFractionLabel(0.5)).toBe("½ Tag");
		expect(dayFractionLabel(1)).toBe("ganzer Tag");
		expect(dayFractionLabel(undefined)).toBe("ganzer Tag");
	});
});

describe("absenceLabel", () => {
	it("nennt den Zeitausgleich beim Namen, sonst die Aktivität", () => {
		expect(absenceLabel(true, "Abwesenheiten")).toBe("Zeitausgleich");
		expect(absenceLabel(false, "Abwesenheiten")).toBe("Abwesenheiten");
	});
});
