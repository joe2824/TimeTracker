// Minimaler XLSX-Leser fuer das erste Arbeitsblatt einer Datei. Ohne Formeln,
// Formatierungen und Zahlenformate - Zahlen kommen roh heraus ("46023.0").

/** Ein eingelesenes Arbeitsblatt. `rows[zeile][spalte]`, Spalte 0 = "A". */
export interface XlsxSheet {
	/** Registername, z.B. "Ergebnisse" */
	name: string;
	/**
	 * Zeilen als Text. Luecken (fehlende Zellen, uebersprungene Zeilen) sind "",
	 * damit der Spaltenindex ueber alle Zeilen derselbe bleibt.
	 */
	rows: string[][];
}

/** Die Datei ist kein lesbares XLSX. Traegt eine Meldung fuer die Oberflaeche. */
export class XlsxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "XlsxError";
	}
}

// ---------- ZIP ----------

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** Maximale Groesse des ZIP-Kommentars (u16) + EOCD-Kopf selbst. */
const EOCD_MAX_SEARCH = 0xffff + 22;

/** Alle Eintraege eines ZIP-Archivs als Name -> Rohdaten (noch gepackt). */
function readZipEntries(buf: Uint8Array): Map<string, { method: number; data: Uint8Array }> {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

	// EOCD von hinten suchen – davor darf ein Kommentar beliebiger Laenge stehen.
	let eocd = -1;
	const from = Math.max(0, buf.length - EOCD_MAX_SEARCH);
	for (let i = buf.length - 22; i >= from; i--) {
		if (view.getUint32(i, true) === EOCD_SIG) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new XlsxError("Die Datei ist kein ZIP-Archiv (und damit keine .xlsx).");

	const count = view.getUint16(eocd + 10, true);
	const cdOffset = view.getUint32(eocd + 16, true);
	// ZIP64 markiert die echten Werte mit lauter Einsen. Solche Archive entstehen
	// ab 4 GB oder 65535 Eintraegen – fuer einen Zeitwirtschaftsreport unmoeglich.
	// Lieber klar scheitern als ein falsches Offset lesen und Kauderwelsch liefern.
	if (cdOffset === 0xffffffff || count === 0xffff) {
		throw new XlsxError("ZIP64-Archive werden nicht unterstützt.");
	}

	const entries = new Map<string, { method: number; data: Uint8Array }>();
	const utf8 = new TextDecoder();
	let p = cdOffset;
	for (let i = 0; i < count; i++) {
		if (p + 46 > buf.length || view.getUint32(p, true) !== CD_SIG) {
			throw new XlsxError("Das ZIP-Verzeichnis ist beschädigt.");
		}
		const method = view.getUint16(p + 10, true);
		const compressedSize = view.getUint32(p + 20, true);
		const nameLen = view.getUint16(p + 28, true);
		const extraLen = view.getUint16(p + 30, true);
		const commentLen = view.getUint16(p + 32, true);
		const localOffset = view.getUint32(p + 42, true);
		const name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen));

		// Der lokale Kopf hat sein EIGENES Extra-Feld, das laenger sein darf als das
		// im Verzeichnis. Es muss hier gelesen werden, sonst zeigt der Datenanfang
		// daneben.
		if (localOffset + 30 > buf.length || view.getUint32(localOffset, true) !== LOCAL_SIG) {
			throw new XlsxError(`Eintrag „${name}" fehlt im Archiv.`);
		}
		const dataStart =
			localOffset +
			30 +
			view.getUint16(localOffset + 26, true) +
			view.getUint16(localOffset + 28, true);
		entries.set(name, { method, data: buf.subarray(dataStart, dataStart + compressedSize) });

		p += 46 + nameLen + extraLen + commentLen;
	}
	return entries;
}

/** Rohes Deflate entpacken (ZIP speichert ohne zlib-Kopf). */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data as BlobPart]).stream().pipeThrough(
		new DecompressionStream("deflate-raw")
	);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Einen Archiv-Eintrag als Text lesen. Null, wenn es ihn nicht gibt. */
async function readText(
	entries: Map<string, { method: number; data: Uint8Array }>,
	name: string
): Promise<string | null> {
	const e = entries.get(name);
	if (!e) return null;
	if (e.method === 0) return new TextDecoder().decode(e.data);
	if (e.method !== 8) throw new XlsxError(`Unbekannte ZIP-Komprimierung (${e.method}).`);
	return new TextDecoder().decode(await inflateRaw(e.data));
}

// ---------- XML ----------

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'"
};

/** XML-Entities aufloesen, inklusive numerischer (&#10; / &#x1F;). */
export function decodeXmlText(s: string): string {
	if (!s.includes("&")) return s;
	return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
		if (body[0] === "#") {
			const code =
				body[1] === "x" || body[1] === "X"
					? parseInt(body.slice(2), 16)
					: parseInt(body.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[body] ?? whole;
	});
}

/** Text aller <t>-Elemente eines Abschnitts, aneinandergehaengt (Rich Text). */
function joinTextRuns(xml: string): string {
	let out = "";
	const re = /<t\b[^>]*?(\/>|>([\s\S]*?)<\/t>)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml))) out += m[2] ? decodeXmlText(m[2]) : "";
	return out;
}

/** Die Zeichenketten-Tabelle (`sharedStrings.xml`), Index = Position. */
export function parseSharedStrings(xml: string | null): string[] {
	if (!xml) return [];
	const out: string[] = [];
	const re = /<si\b[^>]*?(\/>|>([\s\S]*?)<\/si>)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml))) out.push(m[2] ? joinTextRuns(m[2]) : "");
	return out;
}

/** "A" -> 0, "Z" -> 25, "AA" -> 26. -1 bei ungueltiger Referenz. */
export function colIndex(ref: string): number {
	const letters = /^([A-Z]+)/.exec(ref.toUpperCase());
	if (!letters) return -1;
	let n = 0;
	for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

/** Ein Arbeitsblatt in Zeilen zerlegen. */
export function parseSheetXml(xml: string, shared: string[]): string[][] {
	const rows: string[][] = [];
	const rowRe = /<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g;
	const cellRe = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
	let rowMatch: RegExpExecArray | null;
	// Fuer Zeilen ohne `r`: fortlaufend weiterzaehlen.
	let nextRow = 1;

	while ((rowMatch = rowRe.exec(xml))) {
		const rAttr = /\br="(\d+)"/.exec(rowMatch[1]);
		const rowNo = rAttr ? Number(rAttr[1]) : nextRow;
		nextRow = rowNo + 1;
		const body = rowMatch[3] ?? "";
		const cells: string[] = [];
		let nextCol = 0;
		let cellMatch: RegExpExecArray | null;
		cellRe.lastIndex = 0;

		while ((cellMatch = cellRe.exec(body))) {
			const attrs = cellMatch[1];
			const inner = cellMatch[3] ?? "";
			// Position aus `r`, nicht aus der Reihenfolge: XLSX darf leere Zellen und
			// ganze Zeilen auslassen.
			const refAttr = /\br="([A-Z]+\d+)"/.exec(attrs);
			const col = refAttr ? colIndex(refAttr[1]) : nextCol;
			if (col < 0) continue;
			nextCol = col + 1;

			const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
			let value: string;
			if (type === "inlineStr") {
				value = joinTextRuns(inner);
			} else {
				const v = /<v\b[^>]*?(\/>|>([\s\S]*?)<\/v>)/.exec(inner);
				const raw = v?.[2] ? decodeXmlText(v[2]) : "";
				if (type === "s") {
					// Verweis in die Zeichenketten-Tabelle. Die leere Zelle muss VOR der
					// Umwandlung raus: Number("") ist 0, eine Zelle ohne <v> bekaeme sonst
					// den ersten Eintrag der Tabelle – bei einem durch Excel gelaufenen
					// Report also auf jeder leeren Zelle die erste Ueberschrift.
					const idx = raw === "" ? NaN : Number(raw);
					value = Number.isInteger(idx) ? (shared[idx] ?? "") : "";
				} else if (type === "b") {
					value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
				} else {
					// "n" (Zahl), "str" (Formelergebnis), "d" (ISO-Datum), "e" (Fehler)
					value = raw;
				}
			}
			while (cells.length < col) cells.push("");
			cells[col] = value;
		}

		while (rows.length < rowNo - 1) rows.push([]);
		rows[rowNo - 1] = cells;
	}
	return rows;
}

// ---------- Zusammensetzen ----------

/** Pfad des ersten Arbeitsblatts aus workbook.xml + dessen rels. */
function firstSheetPath(workbook: string | null, rels: string | null): { name: string; path: string } {
	const sheet = workbook ? /<sheet\b([^>]*)\/?>/.exec(workbook) : null;
	const name = sheet ? decodeXmlText(/\bname="([^"]*)"/.exec(sheet[1])?.[1] ?? "") : "";
	const rid = sheet ? /\br:id="([^"]+)"/.exec(sheet[1])?.[1] : undefined;

	let target: string | undefined;
	if (rid && rels) {
		const re = /<Relationship\b([^>]*)\/?>/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(rels))) {
			if (/\bId="([^"]+)"/.exec(m[1])?.[1] === rid) {
				target = decodeXmlText(/\bTarget="([^"]*)"/.exec(m[1])?.[1] ?? "");
				break;
			}
		}
	}
	// Ohne Beziehung bleibt die Konvention: das erste Blatt heisst sheet1.xml.
	if (!target) return { name: name || "Tabelle1", path: "xl/worksheets/sheet1.xml" };
	// Ziele sind relativ zu xl/ – ein fuehrender Schraegstrich meint die Wurzel.
	const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
	return { name: name || "Tabelle1", path };
}

/**
 * Das erste Arbeitsblatt einer .xlsx einlesen.
 *
 * @param data Dateiinhalt (z.B. aus `File.arrayBuffer()`)
 * @throws {XlsxError} wenn die Datei kein lesbares XLSX ist
 */
export async function readXlsx(data: ArrayBuffer | Uint8Array): Promise<XlsxSheet> {
	const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
	if (buf.length < 22) throw new XlsxError("Die Datei ist leer oder unvollständig.");

	const entries = readZipEntries(buf);
	const { name, path } = firstSheetPath(
		await readText(entries, "xl/workbook.xml"),
		await readText(entries, "xl/_rels/workbook.xml.rels")
	);
	const sheetXml = await readText(entries, path);
	if (sheetXml === null) throw new XlsxError("In der Datei ist kein Arbeitsblatt zu finden.");

	const shared = parseSharedStrings(await readText(entries, "xl/sharedStrings.xml"));
	return { name, rows: parseSheetXml(sheetXml, shared) };
}
