import { describe, expect, it } from "vitest";
import { colIndex, decodeXmlText, parseSharedStrings, parseSheetXml, readXlsx, XlsxError } from "./xlsx";
import { makeXlsx, makeZip, sheetFromRows } from "./testing/zip";

const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const wrap = (body: string) =>
	`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${SHEET_NS}"><sheetData>${body}</sheetData></worksheet>`;

describe("colIndex", () => {
	it("rechnet Spaltenbuchstaben in Positionen um", () => {
		expect(colIndex("A1")).toBe(0);
		expect(colIndex("N7")).toBe(13);
		expect(colIndex("AA1")).toBe(26);
		expect(colIndex("AB100")).toBe(27);
	});

	it("liefert -1 fuer Unsinn", () => {
		expect(colIndex("7")).toBe(-1);
	});
});

describe("decodeXmlText", () => {
	it("loest benannte und numerische Entities auf", () => {
		expect(decodeXmlText("Arbeitszeit t&#xE4;glich &gt; 10h")).toBe("Arbeitszeit täglich > 10h");
		expect(decodeXmlText("A &amp; B &lt;C&gt; &quot;D&quot; &apos;E&apos;")).toBe(`A & B <C> "D" 'E'`);
		expect(decodeXmlText("Zeile&#10;Umbruch")).toBe("Zeile\nUmbruch");
	});

	it("laesst Unbekanntes stehen", () => {
		expect(decodeXmlText("100&euro;")).toBe("100&euro;");
	});
});

describe("parseSharedStrings", () => {
	it("fasst Rich-Text-Laeufe zu einer Zeichenkette zusammen", () => {
		const xml = `<sst><si><t>Einfach</t></si><si><r><t>Fett</t></r><r><t> und normal</t></r></si><si/></sst>`;
		expect(parseSharedStrings(xml)).toEqual(["Einfach", "Fett und normal", ""]);
	});

	it("kommt ohne Datei aus", () => {
		expect(parseSharedStrings(null)).toEqual([]);
	});
});

describe("parseSheetXml", () => {
	it("haelt Spalten ueber ausgelassene Zellen hinweg an ihrer Position", () => {
		// Genau die Form, die der Zeitwirtschaftsreport liefert: leere Zellen
		// werden weggelassen, die Position steckt nur im r-Attribut.
		const rows = parseSheetXml(
			wrap(
				`<row r="1"><c r="A1" t="inlineStr"><is><t>Tag</t></is></c><c r="D1" t="inlineStr"><is><t>Stunden</t></is></c></row>` +
					`<row r="2"><c r="A2" t="n"><v>46023.0</v></c><c r="D2" t="n"><v>7.5</v></c></row>`
			),
			[]
		);
		expect(rows[0]).toEqual(["Tag", "", "", "Stunden"]);
		expect(rows[1]).toEqual(["46023.0", "", "", "7.5"]);
	});

	it("laesst uebersprungene Zeilen als Luecke stehen", () => {
		const rows = parseSheetXml(
			wrap(`<row r="1"><c r="A1" t="inlineStr"><is><t>oben</t></is></c></row>` +
				`<row r="4"><c r="A4" t="inlineStr"><is><t>unten</t></is></c></row>`),
			[]
		);
		expect(rows).toHaveLength(4);
		expect(rows[0]).toEqual(["oben"]);
		expect(rows[1]).toEqual([]);
		expect(rows[3]).toEqual(["unten"]);
	});

	it("loest Verweise in die Zeichenketten-Tabelle auf", () => {
		const rows = parseSheetXml(
			wrap(`<row r="1"><c r="A1" t="s"><v>1</v></c><c r="B1" t="s"><v>0</v></c></row>`),
			["Null", "Eins"]
		);
		expect(rows[0]).toEqual(["Eins", "Null"]);
	});

	it("haelt eine leere Verweis-Zelle leer, statt den ersten Eintrag zu nehmen", () => {
		// Number("") ist 0 – ohne Wache bekaeme jede leere Zelle eines durch Excel
		// gelaufenen Reports den ersten Tabelleneintrag, also die erste Ueberschrift.
		const rows = parseSheetXml(
			wrap(`<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"/><c r="C1" t="s"><v></v></c></row>`),
			["Personalnummer", "Muster"]
		);
		expect(rows[0]).toEqual(["Personalnummer", "", ""]);
	});

	it("liest Wahrheitswerte, Formelergebnisse und leere Zellen", () => {
		const rows = parseSheetXml(
			wrap(
				`<row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c>` +
					`<c r="C1" t="str"><v>Text</v></c><c r="D1"/><c r="E1" s="3"></c></row>`
			),
			[]
		);
		expect(rows[0]).toEqual(["TRUE", "FALSE", "Text", "", ""]);
	});

	it("zieht Rich Text in Inline-Zellen zusammen", () => {
		const rows = parseSheetXml(
			wrap(`<row r="1"><c r="A1" t="inlineStr"><is><r><t>Ver</t></r><r><t xml:space="preserve">stoß </t></r></is></c></row>`),
			[]
		);
		expect(rows[0]).toEqual(["Verstoß "]);
	});
});

describe("readXlsx", () => {
	it("liest ein deflatiertes Archiv", async () => {
		const zip = await makeXlsx(
			sheetFromRows([
				["Tag", "Arbeitszeit täglich"],
				[46023, 7.5]
			]),
			{ name: "Ergebnisse" }
		);
		const sheet = await readXlsx(zip);
		expect(sheet.name).toBe("Ergebnisse");
		expect(sheet.rows).toEqual([
			["Tag", "Arbeitszeit täglich"],
			["46023", "7.5"]
		]);
	});

	it("liest ein unkomprimiert abgelegtes Archiv", async () => {
		const zip = await makeZip([
			{ name: "xl/worksheets/sheet1.xml", content: sheetFromRows([["A", "B"]]), stored: true }
		]);
		// Ohne workbook.xml greift die Konvention "erstes Blatt = sheet1.xml".
		expect((await readXlsx(zip)).rows[0]).toEqual(["A", "B"]);
	});

	it("folgt der Beziehung auf ein abweichend benanntes Blatt", async () => {
		const zip = await makeZip([
			{
				name: "xl/workbook.xml",
				content:
					`<workbook xmlns="${SHEET_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
					`<sheets><sheet name="Ergebnisse" r:id="rId7" sheetId="1"/></sheets></workbook>`
			},
			{
				name: "xl/_rels/workbook.xml.rels",
				content:
					`<Relationships><Relationship Id="rId7" Target="worksheets/blatt42.xml"/></Relationships>`
			},
			{ name: "xl/worksheets/blatt42.xml", content: sheetFromRows([["gefunden"]]) }
		]);
		expect((await readXlsx(zip)).rows[0]).toEqual(["gefunden"]);
	});

	it("nutzt die Zeichenketten-Tabelle, wenn eine dabei ist", async () => {
		const zip = await makeXlsx(
			`<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
			{ sharedStrings: `<sst><si><t>Personalnummer</t></si></sst>` }
		);
		expect((await readXlsx(zip)).rows[0]).toEqual(["Personalnummer"]);
	});

	it("meldet eine Datei, die kein ZIP ist", async () => {
		const notAZip = new TextEncoder().encode("Das hier ist eine CSV;und kein Archiv;".repeat(4));
		await expect(readXlsx(notAZip)).rejects.toThrow(XlsxError);
	});

	it("meldet ein Archiv ohne Arbeitsblatt", async () => {
		const zip = await makeZip([{ name: "docProps/core.xml", content: "<x/>" }]);
		await expect(readXlsx(zip)).rejects.toThrow(/kein Arbeitsblatt/);
	});

	it("meldet eine leere Datei", async () => {
		await expect(readXlsx(new Uint8Array(4))).rejects.toThrow(/leer|unvollständig/);
	});
});
