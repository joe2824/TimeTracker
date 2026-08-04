// Winziger ZIP-Schreiber – nur fuer Tests, um xlsx.ts mit selbst gebauten
// Archiven zu fuettern (gespeichert UND deflatiert, beide Wege liest der Leser).
//
// Der Gegenpart zu src/lib/xlsx.ts. Bewusst kein Paket: das Format ist hier auf
// die drei Kopfsaetze beschraenkt, die ein XLSX braucht.

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	return table;
})();

function crc32(data: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data as BlobPart])
		.stream()
		.pipeThrough(new CompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface ZipFile {
	name: string;
	content: string;
	/** true = unkomprimiert ablegen (ZIP-Methode 0) */
	stored?: boolean;
}

/** Ein ZIP-Archiv aus Textdateien bauen. */
export async function makeZip(files: ZipFile[]): Promise<Uint8Array> {
	const utf8 = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;

	for (const file of files) {
		const name = utf8.encode(file.name);
		const raw = utf8.encode(file.content);
		const method = file.stored ? 0 : 8;
		const data = file.stored ? raw : await deflateRaw(raw);
		const crc = crc32(raw);

		const local = new Uint8Array(30 + name.length + data.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(8, method, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, data.length, true);
		lv.setUint32(22, raw.length, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);
		local.set(data, 30 + name.length);
		locals.push(local);

		const central = new Uint8Array(46 + name.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(10, method, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, data.length, true);
		cv.setUint32(24, raw.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		central.set(name, 46);
		centrals.push(central);

		offset += local.length;
	}

	const cdSize = centrals.reduce((s, c) => s + c.length, 0);
	const eocd = new Uint8Array(22);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, files.length, true);
	ev.setUint16(10, files.length, true);
	ev.setUint32(12, cdSize, true);
	ev.setUint32(16, offset, true);

	const parts = [...locals, ...centrals, eocd];
	const total = parts.reduce((s, p) => s + p.length, 0);
	const out = new Uint8Array(total);
	let p = 0;
	for (const part of parts) {
		out.set(part, p);
		p += part.length;
	}
	return out;
}

/** Ein XLSX mit genau einem Blatt aus dessen sheet-XML bauen. */
export function makeXlsx(sheetXml: string, opts: { sharedStrings?: string; name?: string } = {}) {
	const files: ZipFile[] = [
		{
			name: "xl/workbook.xml",
			content:
				'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
				`<sheets><sheet name="${opts.name ?? "Ergebnisse"}" r:id="rId3" sheetId="1"/></sheets></workbook>`
		},
		{
			name: "xl/_rels/workbook.xml.rels",
			content:
				'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
				'<Relationship Id="rId3" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>'
		},
		{ name: "xl/worksheets/sheet1.xml", content: sheetXml }
	];
	if (opts.sharedStrings) files.push({ name: "xl/sharedStrings.xml", content: opts.sharedStrings });
	return makeZip(files);
}

/** Blatt-XML aus einer Tabelle bauen (alles als inlineStr, wie es LOGA tut). */
export function sheetFromRows(rows: (string | number | null)[][]): string {
	const col = (i: number) => {
		let s = "";
		let n = i + 1;
		while (n > 0) {
			s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
			n = Math.floor((n - 1) / 26);
		}
		return s;
	};
	const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const body = rows
		.map((row, r) => {
			const cells = row
				.map((v, c) => {
					const ref = `${col(c)}${r + 1}`;
					if (v === null || v === "") return `<c r="${ref}"/>`;
					if (typeof v === "number") return `<c r="${ref}" t="n"><v>${v}</v></c>`;
					return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
				})
				.join("");
			return `<row r="${r + 1}">${cells}</row>`;
		})
		.join("");
	return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}
