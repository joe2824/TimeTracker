import { describe, expect, it } from "vitest";
import { decodeProtectedHeader } from "jose";
import {
	bucketFor,
	checkedPairingKey,
	createClaimSecret,
	createPairingKeyPair,
	createRecoveryPhrase,
	createVaultKey,
	exportPairingPublicKey,
	exportVaultKey,
	formatPairingCode,
	fromBase64,
	fromHex,
	importVaultKey,
	isPairingCode,
	isValidRecoveryPhrase,
	sha256Hex,
	normalizePairingCode,
	normalizePhrase,
	openRecord,
	pairingCode,
	recoveryLookupId,
	sealRecord,
	toBase64,
	toHex,
	type RecordBinding,
	unwrapForDevice,
	unwrapWithPhrase,
	unwrapWithPrf,
	vaultProof,
	wrapForDevice,
	wrapWithPhrase,
	wrapWithPrf
} from "./vault";

const BINDING: RecordBinding = { id: "eintrag-1", kind: "entry", rev: 3 };

/** Was ein Authentifikator mit PRF liefern wuerde: 32 stabile Bytes. */
const prf = (seed = 7) => new Uint8Array(32).fill(seed).buffer;

async function sameKey(a: CryptoKey, b: CryptoKey): Promise<boolean> {
	return toHex(new Uint8Array(await exportVaultKey(a))) === toHex(new Uint8Array(await exportVaultKey(b)));
}

describe("Datensaetze versiegeln", () => {
	it("kommt wieder heraus, was hineinging", async () => {
		const key = await createVaultKey();
		const value = { activityId: "a", startTs: 1000, note: "Kundengespräch" };
		const sealed = await sealRecord(key, value, BINDING);
		expect(await openRecord(key, sealed, BINDING)).toEqual(value);
	});

	it("verraet den Klartext nicht", async () => {
		const key = await createVaultKey();
		const sealed = await sealRecord(key, { note: "Geheimprojekt" }, BINDING);
		expect(sealed).not.toContain("Geheimprojekt");
	});

	it("nimmt bei jedem Mal einen neuen Zufallswert", async () => {
		// Zweimal dasselbe zu verschluesseln darf nicht zweimal dasselbe ergeben,
		// sonst sieht der Server, dass sich nichts geaendert hat. JWE-Compact-Form:
		// header.encryptedKey.iv.ciphertext.tag - bei "dir" bleibt encryptedKey leer.
		const key = await createVaultKey();
		const a = (await sealRecord(key, { x: 1 }, BINDING)).split(".");
		const b = (await sealRecord(key, { x: 1 }, BINDING)).split(".");
		expect(a[2]).not.toBe(b[2]); // iv
		expect(a[3]).not.toBe(b[3]); // ciphertext
	});

	it("laesst sich nicht auf einen anderen Datensatz umhaengen", async () => {
		// Der Server kennt den Inhalt nicht, koennte aber Chiffrate vertauschen.
		// Die Bindung verhindert genau das.
		const key = await createVaultKey();
		const sealed = await sealRecord(key, { x: 1 }, BINDING);
		await expect(openRecord(key, sealed, { ...BINDING, id: "eintrag-2" })).rejects.toThrow();
		await expect(openRecord(key, sealed, { ...BINDING, kind: "activity" })).rejects.toThrow();
		await expect(openRecord(key, sealed, { ...BINDING, rev: 4 })).rejects.toThrow();
	});

	it("merkt eine Verfaelschung", async () => {
		const key = await createVaultKey();
		const sealed = await sealRecord(key, { x: 1 }, BINDING);
		// Ein Zeichen im Ciphertext-Abschnitt kippen (drittletzter Teil vor dem Tag).
		const parts = sealed.split(".");
		const flipped = parts[3][0] === "A" ? "B" : "A";
		parts[3] = flipped + parts[3].slice(1);
		await expect(openRecord(key, parts.join("."), BINDING)).rejects.toThrow();
	});

	it("oeffnet nicht mit einem fremden Schluessel", async () => {
		const sealed = await sealRecord(await createVaultKey(), { x: 1 }, BINDING);
		await expect(openRecord(await createVaultKey(), sealed, BINDING)).rejects.toThrow();
	});
});

describe("Zeitraum-Kennung", () => {
	it("ist stabil fuer denselben Monat und Schluessel", async () => {
		const key = await createVaultKey();
		expect(await bucketFor(key, "2026-07")).toBe(await bucketFor(key, "2026-07"));
	});

	it("unterscheidet Monate", async () => {
		const key = await createVaultKey();
		expect(await bucketFor(key, "2026-07")).not.toBe(await bucketFor(key, "2026-08"));
	});

	it("verraet den Monat nicht", async () => {
		const key = await createVaultKey();
		const bucket = await bucketFor(key, "2026-07");

		// Auf "enthaelt nicht '07'" zu pruefen waere Unfug: in 32 zufaelligen
		// Hex-Zeichen steht jede zweistellige Folge mit rund 11 Prozent
		// Wahrscheinlichkeit irgendwo.
		expect(bucket).toMatch(/^[0-9a-f]{32}$/);
		expect(bucket).not.toBe("2026-07");

		const neighbour = await bucketFor(key, "2026-08");
		const samePlaces = [...bucket].filter((c, i) => c === neighbour[i]).length;
		// Bei einer guten Streuung stimmt rund ein Sechzehntel der Stellen zufaellig
		// ueberein. Die Haelfte waere ein Hinweis darauf, dass der Monat durchschlaegt.
		expect(samePlaces).toBeLessThan(16);
	});

	it("ist bei zwei Konten verschieden, auch fuer denselben Monat", async () => {
		// Sonst koennte der Server zwei Konten daran erkennen, dass sie dieselben
		// Zeitraeume haben.
		const a = await bucketFor(await createVaultKey(), "2026-07");
		const b = await bucketFor(await createVaultKey(), "2026-07");
		expect(a).not.toBe(b);
	});
});

describe("Wiederherstellungs-Phrase", () => {
	it("hat 24 Woerter", () => {
		expect(createRecoveryPhrase().split(" ")).toHaveLength(24);
	});

	it("ist jedes Mal eine andere", () => {
		expect(createRecoveryPhrase()).not.toBe(createRecoveryPhrase());
	});

	it("oeffnet den Tresor wieder", async () => {
		const key = await createVaultKey();
		const phrase = createRecoveryPhrase();
		const wrap = await wrapWithPhrase(key, phrase);
		expect(await sameKey(await unwrapWithPhrase(wrap, phrase), key)).toBe(true);
	});

	it("verzeiht Schreibweise, aber kein falsches Wort", async () => {
		const key = await createVaultKey();
		const phrase = createRecoveryPhrase();
		const wrap = await wrapWithPhrase(key, phrase);
		const sloppy = `  ${phrase.toUpperCase().split(" ").join("   ")}\n`;
		expect(await sameKey(await unwrapWithPhrase(wrap, sloppy), key)).toBe(true);
	});

	it("faellt bei der falschen Phrase auf, statt still einen falschen Schluessel zu liefern", async () => {
		const wrap = await wrapWithPhrase(await createVaultKey(), createRecoveryPhrase());
		await expect(unwrapWithPhrase(wrap, createRecoveryPhrase())).rejects.toThrow();
	});

	it("erkennt ein vertipptes Wort an der Pruefsumme", () => {
		const phrase = createRecoveryPhrase();
		expect(isValidRecoveryPhrase(phrase)).toBe(true);

		// EIN Wort zu ersetzen und "faellt auf" zu erwarten waere ein Test, der
		// gelegentlich grundlos rot ist: bei 24 Woertern hat BIP39 nur 8
		// Pruefbits, ein falsches Wort passt also mit 1:256 zufaellig doch.
		const words = phrase.split(" ");
		const candidates = ["zoo", "zone", "zebra", "young", "youth", "wrong", "wrist", "write"];
		const rejected = candidates
			.filter((w) => w !== words[23])
			.filter((w) => !isValidRecoveryPhrase([...words.slice(0, 23), w].join(" ")));
		expect(rejected.length).toBeGreaterThanOrEqual(5);
	});

	it("weist Unsinn ab", () => {
		expect(isValidRecoveryPhrase("")).toBe(false);
		expect(isValidRecoveryPhrase("dies ist keine phrase")).toBe(false);
	});

	it("vereinheitlicht die Schreibweise", () => {
		expect(normalizePhrase("  Abandon   ABILITY\nable ")).toBe("abandon ability able");
	});

	it("nimmt bei zwei Verpackungen verschiedenen Zufall", async () => {
		const key = await createVaultKey();
		const phrase = createRecoveryPhrase();
		const a = await wrapWithPhrase(key, phrase);
		const b = await wrapWithPhrase(key, phrase);
		// Salz (im Header, PBES2 "p2s") und Chiffrat unterscheiden sich - die ganze
		// Verpackung ist also bei jedem Mal eine andere.
		expect(a).not.toBe(b);
		// Beide oeffnen trotzdem denselben Tresor.
		expect(await sameKey(await unwrapWithPhrase(b, phrase), key)).toBe(true);
	});
});

describe("Passkey-Verpackung (PRF)", () => {
	it("oeffnet den Tresor mit demselben PRF-Wert", async () => {
		const key = await createVaultKey();
		const wrap = await wrapWithPrf(key, prf());
		expect(await sameKey(await unwrapWithPrf(wrap, prf()), key)).toBe(true);
	});

	it("oeffnet nicht mit dem Wert eines anderen Passkeys", async () => {
		const wrap = await wrapWithPrf(await createVaultKey(), prf(7));
		await expect(unwrapWithPrf(wrap, prf(8))).rejects.toThrow();
	});
});

describe("Kopplung eines neuen Geraets", () => {
	it("das neue Geraet oeffnet, was das entsperrte fuer es verpackt hat", async () => {
		const vault = await createVaultKey();
		// Auf dem NEUEN Geraet:
		const freshPair = await createPairingKeyPair();
		const publicSide = await exportPairingPublicKey(freshPair);
		// Auf dem ENTSPERRTEN Geraet:
		const packet = await wrapForDevice(vault, publicSide);
		// Zurueck auf dem neuen Geraet:
		expect(await sameKey(await unwrapForDevice(packet, freshPair.privateKey), vault)).toBe(true);
	});

	it("ein fremdes Geraet oeffnet das Paket nicht", async () => {
		const vault = await createVaultKey();
		const meant = await createPairingKeyPair();
		const foreign = await createPairingKeyPair();
		const packet = await wrapForDevice(vault, await exportPairingPublicKey(meant));
		await expect(unwrapForDevice(packet, foreign.privateKey)).rejects.toThrow();
	});

	it("weist ein Paket ab, dessen fluechtiger Schluessel im Header fehlt", async () => {
		// `epk` (der fluechtige oeffentliche Schluessel) liegt im geschuetzten
		// JWE-Header - der ist Teil der authentisierten Daten. Ein Paket ohne ihn
		// (oder mit veraendertem Header) faellt beim Oeffnen durch, weil die
		// Pruefsumme nicht mehr passt - unabhaengig davon, was genau am Header fehlt.
		const vault = await createVaultKey();
		const freshPair = await createPairingKeyPair();
		const packet = await wrapForDevice(vault, await exportPairingPublicKey(freshPair));
		const [header, ...rest] = packet.split(".");
		const headerJson = JSON.parse(Buffer.from(header, "base64url").toString());
		delete headerJson.epk;
		const strippedHeader = Buffer.from(JSON.stringify(headerJson)).toString("base64url");
		await expect(
			unwrapForDevice([strippedHeader, ...rest].join("."), freshPair.privateKey)
		).rejects.toThrow();
	});

	it("jede Kopplung nimmt ein neues fluechtiges Paar", async () => {
		const vault = await createVaultKey();
		const freshPair = await createPairingKeyPair();
		const pub = await exportPairingPublicKey(freshPair);
		const a = await wrapForDevice(vault, pub);
		const b = await wrapForDevice(vault, pub);
		const epkOf = (jwe: string) => (decodeProtectedHeader(jwe) as { epk?: { x?: string } }).epk?.x;
		expect(epkOf(a)).not.toBe(epkOf(b));
	});
});

describe("mehrere Wege zum selben Tresor", () => {
	it("Phrase, Passkey und Geraet oeffnen denselben Schluessel", async () => {
		// Das ist der Kern des Entwurfs: EIN Tresorschluessel, mehrere Oeffner.
		// Geht ein Weg verloren, bleiben die anderen.
		const vault = await createVaultKey();
		const phrase = createRecoveryPhrase();
		const device = await createPairingKeyPair();

		const fromPhrase = await unwrapWithPhrase(await wrapWithPhrase(vault, phrase), phrase);
		const fromPrf = await unwrapWithPrf(await wrapWithPrf(vault, prf()), prf());
		const fromDevice = await unwrapForDevice(
			await wrapForDevice(vault, await exportPairingPublicKey(device)),
			device.privateKey
		);

		expect(await sameKey(fromPhrase, vault)).toBe(true);
		expect(await sameKey(fromPrf, vault)).toBe(true);
		expect(await sameKey(fromDevice, vault)).toBe(true);

		// Und ein Datensatz, der mit dem einen versiegelt wurde, geht mit dem
		// anderen auf.
		const sealed = await sealRecord(fromPhrase, { note: "egal" }, BINDING);
		expect(await openRecord(fromDevice, sealed, BINDING)).toEqual({ note: "egal" });
	});
});

describe("Kodierung", () => {
	it("hex hin und zurueck", () => {
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		expect(fromHex(toHex(bytes))).toEqual(bytes);
	});

	it("base64 hin und zurueck", () => {
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		expect(fromBase64(toBase64(bytes))).toEqual(bytes);
	});

	it("base64 vertraegt alle Bytewerte", () => {
		const all = new Uint8Array(256).map((_, i) => i);
		expect(fromBase64(toBase64(all))).toEqual(all);
	});

	it("Schluessel ueberstehen den Umweg ueber Rohbytes", async () => {
		const key = await createVaultKey();
		const wieder = await importVaultKey(await exportVaultKey(key));
		expect(await sameKey(wieder, key)).toBe(true);
	});
});

describe("Der Kopplungscode", () => {
	const key = async () => exportPairingPublicKey(await createPairingKeyPair());

	it("rechnet, was eine unabhaengige Umsetzung auch rechnet", async () => {
		// Ein fester Vektor, nachgerechnet mit einer eigenen Umsetzung ausserhalb
		// dieses Programms: SHA-256 ueber die Bytes 0..64, davon die obersten 60 Bit
		// zu zwoelf Stellen a fuenf Bit.
		const probe = new Uint8Array(65).map((_, i) => i);
		expect(await pairingCode(probe)).toBe("KR8U3C5RD5YH");
	});

	it("ist der Abdruck des Schluessels, nicht Zufall", async () => {
		const pub = await key();
		expect(await pairingCode(pub)).toBe(await pairingCode(pub));
	});

	it("hat zwoelf Stellen aus dem Alphabet ohne I, O, 0 und 1", async () => {
		for (let i = 0; i < 20; i++) {
			const code = await pairingCode(await key());
			expect(code).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);
			expect(isPairingCode(code)).toBe(true);
		}
	});

	it("ist fuer zwei Schluessel ein anderer", async () => {
		// Die Eigenschaft, auf der alles beruht: ein untergeschobener Schluessel
		// ergibt nicht denselben Code.
		const codes = new Set<string>();
		for (let i = 0; i < 30; i++) codes.add(await pairingCode(await key()));
		expect(codes.size).toBe(30);
	});

	it("aendert sich, wenn sich ein einziges Byte aendert", async () => {
		const pub = await key();
		const bent = new Uint8Array(pub);
		bent[20] ^= 1;
		expect(await pairingCode(bent)).not.toBe(await pairingCode(pub));
	});

	it("wird angezeigt, wie er sich abtippen laesst", async () => {
		const code = await pairingCode(await key());
		const shown = formatPairingCode(code);
		expect(shown).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
		// Mit Bindestrichen abgetippt, mit Leerzeichen, in Kleinbuchstaben: immer
		// derselbe Code.
		expect(normalizePairingCode(shown)).toBe(code);
		expect(normalizePairingCode(shown.toLowerCase())).toBe(code);
		expect(normalizePairingCode(shown.replace(/-/g, " "))).toBe(code);
	});
});

describe("Das Abhol-Geheimnis", () => {
	// Der Kopplungscode ist der Abdruck des Geraeteschluessels und muss sichtbar
	// sein - ein Mensch soll ihn vergleichen. Zum Abholen des Geraete-Tokens
	// taugt er deshalb nicht: dafuer gibt es dieses Geheimnis, das das Geraet
	// behaelt und von dem der Server nur den Hash sieht.

	it("gibt ein Geheimnis und dessen Hash", async () => {
		const { secret, hash } = await createClaimSecret();
		expect(secret.length).toBeGreaterThan(20);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(await sha256Hex(secret)).toBe(hash);
	});

	it("wuerfelt jedes Mal neu", async () => {
		// Zwei Geraete, die gleichzeitig koppeln, duerfen sich nicht dasselbe
		// Geheimnis teilen - sonst holte eines das Token des anderen ab.
		const a = await createClaimSecret();
		const b = await createClaimSecret();
		expect(a.secret).not.toBe(b.secret);
		expect(a.hash).not.toBe(b.hash);
	});

	it("rechnet denselben Hash wie der Server", async () => {
		// Angenagelt an einen festen Wert, und derselbe Wert steht in
		// server/src/lib/server/api.test.ts. Driften die beiden Rechnungen
		// auseinander, koppelt gar nichts mehr - und zwar still, weil der Server
		// dann schlicht 404 antwortet.
		expect(await sha256Hex("geheim-abholen")).toBe(
			"38493643ffb2d864afda079804427ffd9224181468ba3dd5fcd018863d169da2"
		);
	});
});

describe("checkedPairingKey", () => {
	it("gibt den Schluessel heraus, der zum Code gehoert", async () => {
		const pub = await exportPairingPublicKey(await createPairingKeyPair());
		const code = await pairingCode(pub);
		expect(await checkedPairingKey(code, toBase64(pub))).toEqual(pub);
		// Auch so, wie ein Mensch ihn abtippt.
		expect(await checkedPairingKey(formatPairingCode(code), toBase64(pub))).toEqual(pub);
	});

	it("weist einen untergeschobenen Schluessel ab", async () => {
		// GENAU der Angriff, gegen den die Bindung da ist: das neue Geraet
		// hinterlegt seinen Schluessel und zeigt dessen Code an. Wer den Server
		// beherrscht, tauscht den hinterlegten Schluessel gegen einen eigenen -
		// und bekaeme vom bestaetigenden Geraet den Tresorschluessel dagegen
		// verpackt. Danach koennte er jeden Datensatz des Kontos lesen.
		const real = await exportPairingPublicKey(await createPairingKeyPair());
		const attacker = await exportPairingPublicKey(await createPairingKeyPair());
		const readOff = await pairingCode(real);

		await expect(checkedPairingKey(readOff, toBase64(attacker))).rejects.toThrow(
			/passt nicht zu diesem Code/
		);
	});

	it("weist auch einen verbogenen Schluessel ab", async () => {
		// Nicht nur ein ganz anderer Schluessel: ein einziges gekipptes Bit reicht.
		const real = await exportPairingPublicKey(await createPairingKeyPair());
		const code = await pairingCode(real);
		const bent = new Uint8Array(real);
		bent[5] ^= 0x80;
		await expect(checkedPairingKey(code, toBase64(bent))).rejects.toThrow();
	});

	it("der geprüfte Schluessel oeffnet das Paket wirklich", async () => {
		// Ende zu Ende: was checkedPairingKey durchlaesst, ist der Schluessel, mit
		// dem das neue Geraet sein Paket auch aufbekommt.
		const pair = await createPairingKeyPair();
		const pub = await exportPairingPublicKey(pair);
		const code = await pairingCode(pub);

		const vault = await createVaultKey();
		const checked = await checkedPairingKey(code, toBase64(pub));
		const packet = await wrapForDevice(vault, checked);

		const wieder = await unwrapForDevice(packet, pair.privateKey);
		expect(await sameKey(wieder, vault)).toBe(true);
	});
});

describe("Wiederherstellung ueber die Phrase", () => {
	it("dieselbe Phrase ergibt dieselbe Kennung", async () => {
		const p = createRecoveryPhrase();
		expect(await recoveryLookupId(p)).toBe(await recoveryLookupId(p));
	});

	it("verschiedene Phrasen ergeben verschiedene Kennungen", async () => {
		const a = await recoveryLookupId(createRecoveryPhrase());
		const b = await recoveryLookupId(createRecoveryPhrase());
		expect(a).not.toBe(b);
	});

	it("ist gegen Schreibweise unempfindlich", async () => {
		// Wer abschreibt, tippt Grossbuchstaben und doppelte Leerzeichen. Daran
		// darf eine Wiederherstellung nicht scheitern.
		const p = createRecoveryPhrase();
		const scrambled = `  ${p.toUpperCase().replace(/ /g, "   ")}  `;
		expect(await recoveryLookupId(scrambled)).toBe(await recoveryLookupId(p));
	});

	it("verraet die Phrase nicht", async () => {
		const p = createRecoveryPhrase();
		const id = await recoveryLookupId(p);
		// Kein Wort der Phrase darf in der Kennung auftauchen.
		for (const word of p.split(" ")) {
			expect(id).not.toContain(word);
		}
		expect(id).toMatch(/^[0-9a-f]{64}$/);
	});

	it("folgt der Entropie der Phrase, nicht ihrem Text", async () => {
		// Der Schluessel entsteht aus der ENTROPIE der Phrase (siehe kekFromPhrase),
		// nicht aus ihrem Text - sonst haetten Schluessel und Kennung verschiedene
		// Vorstellungen davon, wann zwei Phrasen gleich sind, und eine gueltige
		// Schreibweise faende kein Konto.
		const p = createRecoveryPhrase();
		expect(await recoveryLookupId(p)).toMatch(/^[0-9a-f]{64}$/);
		await expect(recoveryLookupId("kein wort davon ist eine phrase")).rejects.toThrow();
	});

	it("die Kennung oeffnet die Verpackung NICHT", async () => {
		// Der Punkt, an dem alles haengt: Kennung und Schluessel entstehen aus
		// derselben Phrase, aber ueber getrennte Wege. Waeren es dieselben Bytes,
		// gaebe der Server mit der Kennung den Schluessel heraus.
		const key = await createVaultKey();
		const p = createRecoveryPhrase();
		const wrap = await wrapWithPhrase(key, p);
		const id = await recoveryLookupId(p);
		await expect(unwrapWithPhrase(wrap, id)).rejects.toThrow();
	});

	it("der Nachweis ist an den Tresorschluessel gebunden", async () => {
		const a = await createVaultKey();
		const b = await createVaultKey();
		expect(await vaultProof(a)).toBe(await vaultProof(a));
		expect(await vaultProof(a)).not.toBe(await vaultProof(b));
	});

	it("der Nachweis gibt den Schluessel nicht her", async () => {
		const key = await createVaultKey();
		const raw = new Uint8Array(await exportVaultKey(key));
		const proof = await vaultProof(key);
		// Der Schluessel selbst darf im Nachweis nicht auftauchen.
		const hex = [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
		expect(proof).not.toBe(hex);
		expect(proof).not.toContain(hex.slice(0, 16));
	});

	it("der ganze Weg: Phrase rein, Tresorschluessel raus", async () => {
		const key = await createVaultKey();
		const p = createRecoveryPhrase();
		const wrap = await wrapWithPhrase(key, p);

		// Was der Server hat: Kennung, Nachweis, Chiffrat.
		const id = await recoveryLookupId(p);
		const proof = await vaultProof(key);

		// Was auf dem neuen Geraet passiert: Kennung rechnen, Verpackung holen,
		// oeffnen, Nachweis rechnen.
		expect(await recoveryLookupId(p)).toBe(id);
		const back = await unwrapWithPhrase(wrap, p);
		expect(await vaultProof(back)).toBe(proof);

		// Und der Schluessel ist wirklich derselbe.
		expect(new Uint8Array(await exportVaultKey(back))).toEqual(
			new Uint8Array(await exportVaultKey(key))
		);
	});
});
