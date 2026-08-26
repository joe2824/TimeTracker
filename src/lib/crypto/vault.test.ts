import { describe, expect, it } from "vitest";
import {
	bucketFor,
	checkedPairingKey,
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
	normalizePairingCode,
	normalizePhrase,
	pairingCode,
	openRecord,
	sealRecord,
	toBase64,
	toHex,
	unwrapForDevice,
	unwrapWithPhrase,
	unwrapWithPrf,
	wrapForDevice,
	wrapWithPhrase,
	wrapWithPrf,
	type RecordBinding
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
		const wert = { activityId: "a", startTs: 1000, note: "Kundengespräch" };
		const sealed = await sealRecord(key, wert, BINDING);
		expect(await openRecord(key, sealed, BINDING)).toEqual(wert);
	});

	it("verraet den Klartext nicht", async () => {
		const key = await createVaultKey();
		const sealed = await sealRecord(key, { note: "Geheimprojekt" }, BINDING);
		expect(new TextDecoder().decode(sealed.ciphertext)).not.toContain("Geheimprojekt");
	});

	it("nimmt bei jedem Mal einen neuen Zufallswert", async () => {
		// Zweimal dasselbe zu verschluesseln darf nicht zweimal dasselbe ergeben,
		// sonst sieht der Server, dass sich nichts geaendert hat.
		const key = await createVaultKey();
		const a = await sealRecord(key, { x: 1 }, BINDING);
		const b = await sealRecord(key, { x: 1 }, BINDING);
		expect(toHex(a.iv)).not.toBe(toHex(b.iv));
		expect(toHex(a.ciphertext)).not.toBe(toHex(b.ciphertext));
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
		sealed.ciphertext[0] ^= 0xff;
		await expect(openRecord(key, sealed, BINDING)).rejects.toThrow();
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
		// Wahrscheinlichkeit irgendwo. Genau daran ist dieser Test einmal
		// grundlos gescheitert.
		//
		// Die Eigenschaft, um die es geht, ist eine andere: aus der Kennung darf
		// sich der Monat nicht ZURUECKRECHNEN lassen. Dafuer muss sie erstens
		// nichts Erkennbares sein und zweitens bei einem benachbarten Monat
		// voellig anders aussehen - nicht "um eins verschoben".
		expect(bucket).toMatch(/^[0-9a-f]{32}$/);
		expect(bucket).not.toBe("2026-07");

		const nachbar = await bucketFor(key, "2026-08");
		const gleicheStellen = [...bucket].filter((c, i) => c === nachbar[i]).length;
		// Bei einer guten Streuung stimmt rund ein Sechzehntel der Stellen zufaellig
		// ueberein. Die Haelfte waere ein Hinweis darauf, dass der Monat durchschlaegt.
		expect(gleicheStellen).toBeLessThan(16);
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
		const geschludert = `  ${phrase.toUpperCase().split(" ").join("   ")}\n`;
		expect(await sameKey(await unwrapWithPhrase(wrap, geschludert), key)).toBe(true);
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
		// Pruefbits, ein falsches Wort passt also mit 1:256 zufaellig doch. Genau
		// das ist hier einmal passiert.
		//
		// Geprueft wird deshalb die Eigenschaft, um die es geht: unter den
		// moeglichen Ersetzungen des letzten Wortes muss die grosse Mehrheit
		// auffallen. Trifft die Pruefsumme, faellt keine einzige auf.
		const woerter = phrase.split(" ");
		const kandidaten = ["zoo", "zone", "zebra", "young", "youth", "wrong", "wrist", "write"];
		const abgewiesen = kandidaten
			.filter((w) => w !== woerter[23])
			.filter((w) => !isValidRecoveryPhrase([...woerter.slice(0, 23), w].join(" ")));
		expect(abgewiesen.length).toBeGreaterThanOrEqual(5);
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
		expect(toHex(a.salt)).not.toBe(toHex(b.salt));
		expect(toHex(a.wrapped)).not.toBe(toHex(b.wrapped));
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
		const neu = await createPairingKeyPair();
		const oeffentlich = await exportPairingPublicKey(neu);
		// Auf dem ENTSPERRTEN Geraet:
		const paket = await wrapForDevice(vault, oeffentlich);
		// Zurueck auf dem neuen Geraet:
		expect(await sameKey(await unwrapForDevice(paket, neu.privateKey), vault)).toBe(true);
	});

	it("ein fremdes Geraet oeffnet das Paket nicht", async () => {
		const vault = await createVaultKey();
		const gemeint = await createPairingKeyPair();
		const fremd = await createPairingKeyPair();
		const paket = await wrapForDevice(vault, await exportPairingPublicKey(gemeint));
		await expect(unwrapForDevice(paket, fremd.privateKey)).rejects.toThrow();
	});

	it("weist ein Paket ohne oeffentlichen Schluessel ab", async () => {
		const vault = await createVaultKey();
		const neu = await createPairingKeyPair();
		const paket = await wrapForDevice(vault, await exportPairingPublicKey(neu));
		delete paket.ephemeralPublicKey;
		await expect(unwrapForDevice(paket, neu.privateKey)).rejects.toThrow(/öffentlichen Schlüssel/);
	});

	it("jede Kopplung nimmt ein neues fluechtiges Paar", async () => {
		const vault = await createVaultKey();
		const neu = await createPairingKeyPair();
		const pub = await exportPairingPublicKey(neu);
		const a = await wrapForDevice(vault, pub);
		const b = await wrapForDevice(vault, pub);
		expect(toHex(a.ephemeralPublicKey!)).not.toBe(toHex(b.ephemeralPublicKey!));
	});
});

describe("mehrere Wege zum selben Tresor", () => {
	it("Phrase, Passkey und Geraet oeffnen denselben Schluessel", async () => {
		// Das ist der Kern des Entwurfs: EIN Tresorschluessel, mehrere Oeffner.
		// Geht ein Weg verloren, bleiben die anderen.
		const vault = await createVaultKey();
		const phrase = createRecoveryPhrase();
		const geraet = await createPairingKeyPair();

		const ausPhrase = await unwrapWithPhrase(await wrapWithPhrase(vault, phrase), phrase);
		const ausPrf = await unwrapWithPrf(await wrapWithPrf(vault, prf()), prf());
		const ausGeraet = await unwrapForDevice(
			await wrapForDevice(vault, await exportPairingPublicKey(geraet)),
			geraet.privateKey
		);

		expect(await sameKey(ausPhrase, vault)).toBe(true);
		expect(await sameKey(ausPrf, vault)).toBe(true);
		expect(await sameKey(ausGeraet, vault)).toBe(true);

		// Und ein Datensatz, der mit dem einen versiegelt wurde, geht mit dem
		// anderen auf.
		const sealed = await sealRecord(ausPhrase, { note: "egal" }, BINDING);
		expect(await openRecord(ausGeraet, sealed, BINDING)).toEqual({ note: "egal" });
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
		const alle = new Uint8Array(256).map((_, i) => i);
		expect(fromBase64(toBase64(alle))).toEqual(alle);
	});

	it("Schluessel ueberstehen den Umweg ueber Rohbytes", async () => {
		const key = await createVaultKey();
		const wieder = await importVaultKey(await exportVaultKey(key));
		expect(await sameKey(wieder, key)).toBe(true);
	});
});

describe("Der Kopplungscode", () => {
	const schluessel = async () => exportPairingPublicKey(await createPairingKeyPair());

	it("rechnet, was eine unabhaengige Umsetzung auch rechnet", async () => {
		// Ein fester Vektor, nachgerechnet mit einer eigenen Umsetzung ausserhalb
		// dieses Programms: SHA-256 ueber die Bytes 0..64, davon die obersten 60 Bit
		// zu zwoelf Stellen a fuenf Bit.
		//
		// Der Vektor steht hier, weil die Bit-Schieberei in pairingCode aussieht,
		// als koenne man sie "aufraeumen". Wer sie dabei um ein Bit verschiebt,
		// bekommt weiterhin huebsche Codes - nur eben andere, und die Kopplung
		// zwischen zwei Fassungen des Programms schluege fehl, ohne dass jemand
		// saehe warum.
		const probe = new Uint8Array(65).map((_, i) => i);
		expect(await pairingCode(probe)).toBe("KR8U3C5RD5YH");
	});

	it("ist der Abdruck des Schluessels, nicht Zufall", async () => {
		const pub = await schluessel();
		expect(await pairingCode(pub)).toBe(await pairingCode(pub));
	});

	it("hat zwoelf Stellen aus dem Alphabet ohne I, O, 0 und 1", async () => {
		for (let i = 0; i < 20; i++) {
			const code = await pairingCode(await schluessel());
			expect(code).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);
			expect(isPairingCode(code)).toBe(true);
		}
	});

	it("ist fuer zwei Schluessel ein anderer", async () => {
		// Die Eigenschaft, auf der alles beruht: ein untergeschobener Schluessel
		// ergibt nicht denselben Code.
		const codes = new Set<string>();
		for (let i = 0; i < 30; i++) codes.add(await pairingCode(await schluessel()));
		expect(codes.size).toBe(30);
	});

	it("aendert sich, wenn sich ein einziges Byte aendert", async () => {
		const pub = await schluessel();
		const verbogen = new Uint8Array(pub);
		verbogen[20] ^= 1;
		expect(await pairingCode(verbogen)).not.toBe(await pairingCode(pub));
	});

	it("wird angezeigt, wie er sich abtippen laesst", async () => {
		const code = await pairingCode(await schluessel());
		const angezeigt = formatPairingCode(code);
		expect(angezeigt).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
		// Mit Bindestrichen abgetippt, mit Leerzeichen, in Kleinbuchstaben: immer
		// derselbe Code.
		expect(normalizePairingCode(angezeigt)).toBe(code);
		expect(normalizePairingCode(angezeigt.toLowerCase())).toBe(code);
		expect(normalizePairingCode(angezeigt.replace(/-/g, " "))).toBe(code);
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
		//
		// Der Code auf dem Bildschirm gehoert aber weiterhin zum ECHTEN Schluessel.
		const echt = await exportPairingPublicKey(await createPairingKeyPair());
		const angreifer = await exportPairingPublicKey(await createPairingKeyPair());
		const abgelesen = await pairingCode(echt);

		await expect(checkedPairingKey(abgelesen, toBase64(angreifer))).rejects.toThrow(
			/passt nicht zu diesem Code/
		);
	});

	it("weist auch einen verbogenen Schluessel ab", async () => {
		// Nicht nur ein ganz anderer Schluessel: ein einziges gekipptes Bit reicht.
		const echt = await exportPairingPublicKey(await createPairingKeyPair());
		const code = await pairingCode(echt);
		const verbogen = new Uint8Array(echt);
		verbogen[5] ^= 0x80;
		await expect(checkedPairingKey(code, toBase64(verbogen))).rejects.toThrow();
	});

	it("der geprüfte Schluessel oeffnet das Paket wirklich", async () => {
		// Ende zu Ende: was checkedPairingKey durchlaesst, ist der Schluessel, mit
		// dem das neue Geraet sein Paket auch aufbekommt.
		const paar = await createPairingKeyPair();
		const pub = await exportPairingPublicKey(paar);
		const code = await pairingCode(pub);

		const tresor = await createVaultKey();
		const geprueft = await checkedPairingKey(code, toBase64(pub));
		const paket = await wrapForDevice(tresor, geprueft);

		const wieder = await unwrapForDevice(paket, paar.privateKey);
		expect(await sameKey(wieder, tresor)).toBe(true);
	});
});
