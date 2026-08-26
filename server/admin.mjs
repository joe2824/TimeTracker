// Verwaltung von der Kommandozeile - im Container.
//
// Wofuer das da ist: irgendwer muss der erste Verwalter sein, und niemand kann
// ihn ueber die Oberflaeche dazu machen - es gibt ja noch keinen, der es
// duerfte. Das ist die Henne-und-Ei-Frage jeder Rechteverwaltung, und sie wird
// hier beantwortet, wo ohnehin nur hinkommt, wer den Server betreibt.
//
// Bewusst NICHT als Endpunkt mit einem geheimen Schluessel: ein Endpunkt, der
// Rechte vergeben kann, ist dauerhaft im Netz erreichbar. Dieses Skript ist es
// nur, solange jemand es aufruft.
//
// Aufruf:
//   docker compose exec timetracker node admin.mjs liste
//   docker compose exec timetracker node admin.mjs ernenne <id-oder-name>
//   docker compose exec timetracker node admin.mjs entziehe <id-oder-name>
//   docker compose exec timetracker node admin.mjs einladung [notiz] [--tage 14]
import Database from "better-sqlite3";
import { randomInt } from "node:crypto";

const DATEI = process.env.DB_FILE ?? `${process.env.DATA_DIR ?? "/data"}/timetracker.db`;
const db = new Database(DATEI);

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const neuerCode = () =>
	Array.from({ length: 4 }, () =>
		Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")
	).join("-");

const datum = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "–");

/**
 * Ein Konto finden - ueber die Kennung, ihren Anfang, oder den Anzeigenamen.
 *
 * Drei Wege, weil keiner allein reicht: die Kennung ist eindeutig, aber eine
 * UUID tippt niemand ab. Der Name ist tippbar, aber nicht eindeutig - es koennen
 * zwei Anna sein. Der Anfang der Kennung ist beides, sobald man ihn aus der
 * Liste abgelesen hat.
 *
 * Treffen mehrere zu, wird NICHTS getan und die Auswahl aufgelistet. Den
 * Falschen zum Verwalter zu machen, weil zwei Leute gleich heissen, waere ein
 * stiller Fehler - und der Betroffene merkte es nie.
 */
function findeKonto(suche) {
	const genau = db.prepare("SELECT * FROM users WHERE id = ?").get(suche);
	if (genau) return { treffer: [genau] };

	// Der Anfang der Kennung. Ab vier Zeichen, sonst trifft es zu leicht mehrere.
	if (suche.length >= 4) {
		const nachPraefix = db.prepare("SELECT * FROM users WHERE id LIKE ?").all(`${suche}%`);
		if (nachPraefix.length > 0) return { treffer: nachPraefix };
	}

	return {
		treffer: db.prepare("SELECT * FROM users WHERE lower(display_name) = lower(?)").all(suche)
	};
}

/**
 * Woran man zwei gleichnamige Konten auseinanderhaelt.
 *
 * Wann angelegt, wie viele Geraete, wann zuletzt gesehen. Das eigene erkennt man
 * am Geraet, das man selbst gerade benutzt - und am Zeitpunkt, zu dem man sich
 * angemeldet hat.
 */
function merkmale(id) {
	const geraete = db
		.prepare("SELECT label, last_seen_at FROM devices WHERE user_id = ? AND revoked_at IS NULL")
		.all(id);
	const datensaetze = db.prepare("SELECT count(*) n FROM records WHERE user_id = ?").get(id).n;
	const zuletzt = geraete.reduce((m, g) => Math.max(m, g.last_seen_at ?? 0), 0);
	return {
		geraete: geraete.map((g) => g.label).join(", ") || "keine",
		datensaetze,
		zuletzt
	};
}

function liste() {
	const konten = db
		.prepare("SELECT id, display_name, is_admin, created_at FROM users ORDER BY created_at")
		.all();
	if (konten.length === 0) {
		console.log("Noch keine Konten. Der erste Mensch registriert sich über die Weboberfläche –");
		console.log("mit einem Code aus INVITE_CODES. Danach hier zum Verwalter ernennen.");
		return;
	}
	console.log("\nKonten:\n");
	for (const k of konten) {
		const m = merkmale(k.id);
		console.log(
			`  ${k.is_admin ? "[Verwalter]" : "[         ]"}  ${k.display_name.padEnd(20)}  ${k.id}`
		);
		console.log(
			`                 seit ${datum(k.created_at)}   Geräte: ${m.geraete}   Datensätze: ${m.datensaetze}`
		);
	}

	const codes = db.prepare("SELECT * FROM invites ORDER BY created_at DESC LIMIT 20").all();
	console.log(`\nEinladungen (${codes.length}):\n`);
	for (const c of codes) {
		const stand = c.used_at
			? `benutzt ${datum(c.used_at)}`
			: c.revoked_at
				? "zurückgezogen"
				: c.expires_at && c.expires_at < Date.now()
					? "abgelaufen"
					: "offen";
		console.log(`  ${c.code}  ${stand.padEnd(22)} ${c.note ?? ""}`);
	}

	const ausUmgebung = (process.env.INVITE_CODES ?? "").split(",").filter(Boolean);
	if (ausUmgebung.length > 0) {
		console.log(`\nAchtung: ${ausUmgebung.length} Code(s) stehen in INVITE_CODES.`);
		console.log("Die gelten unbegrenzt und mehrfach. Sobald es einen Verwalter gibt,");
		console.log("sollten sie aus der .env verschwinden – dann wird jede Einladung einzeln");
		console.log("vergeben und ist nachvollziehbar.");
	}
	console.log("");
}

function setzeRolle(suche, wert) {
	const { treffer } = findeKonto(suche);
	if (treffer.length === 0) {
		console.error(`Kein Konto gefunden für "${suche}". "node admin.mjs liste" zeigt alle.`);
		process.exit(1);
	}
	if (treffer.length > 1) {
		console.error("");
		console.error(`Mehrdeutig – ${treffer.length} Konten passen auf "${suche}".`);
		console.error("");
		console.error("Welches gemeint ist, sagt am ehesten das Gerät oder der Zeitpunkt:");
		console.error("");
		for (const t of treffer) {
			const m = merkmale(t.id);
			console.error(`  ${t.display_name}`);
			console.error(`    Kennung     ${t.id}`);
			console.error(`    angelegt    ${datum(t.created_at)}`);
			console.error(`    Geräte      ${m.geraete}`);
			console.error(`    zuletzt     ${m.zuletzt ? datum(m.zuletzt) : "nie verbunden"}`);
			console.error(`    Datensätze  ${m.datensaetze}`);
			console.error("");
		}
		// Der Anfang der Kennung genuegt - die ganze UUID tippt niemand ab.
		console.error(`Dann z. B.:  node admin.mjs ernenne ${treffer[0].id.slice(0, 8)}`);
		console.error("");
		process.exit(1);
	}
	const k = treffer[0];
	db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(wert ? 1 : 0, k.id);
	console.log(
		`${k.display_name} (${k.id}) ist ${wert ? "jetzt Verwalter" : "kein Verwalter mehr"}.`
	);
	if (!wert) {
		const rest = db.prepare("SELECT count(*) n FROM users WHERE is_admin = 1").get().n;
		if (rest === 0) {
			console.log("\nHinweis: Es gibt jetzt KEINEN Verwalter mehr. Einladungen lassen sich");
			console.log("nur noch hier ausstellen, nicht mehr über die Oberfläche.");
		}
	}
}

function einladung(argv) {
	const tageIndex = argv.indexOf("--tage");
	const tage = tageIndex >= 0 ? Number(argv[tageIndex + 1]) : 0;
	const notiz = argv.filter((a, i) => i !== tageIndex && i !== tageIndex + 1).join(" ") || null;

	const code = neuerCode();
	db.prepare(
		"INSERT INTO invites (code, created_at, created_by, note, expires_at) VALUES (?,?,?,?,?)"
	).run(code, Date.now(), null, notiz, tage > 0 ? Date.now() + tage * 86_400_000 : null);
	console.log(`\n  ${code}\n`);
	console.log(tage > 0 ? `  Gilt ${tage} Tage, genau einmal.` : "  Gilt unbegrenzt, genau einmal.");
	if (notiz) console.log(`  Notiz: ${notiz}`);
	console.log("");
}

const [befehl, ...rest] = process.argv.slice(2);
switch (befehl) {
	case "liste":
		liste();
		break;
	case "ernenne":
		setzeRolle(rest[0], true);
		break;
	case "entziehe":
		setzeRolle(rest[0], false);
		break;
	case "einladung":
		einladung(rest);
		break;
	default:
		console.log(`
Verwaltung des TimeTracker-Servers.

  node admin.mjs liste                     Konten und Einladungen zeigen
  node admin.mjs ernenne <wen>             Zum Verwalter machen
  node admin.mjs entziehe <wen>            Verwalterrolle nehmen

  <wen> ist die Kennung, ihr Anfang (ab vier Zeichen) oder der Anzeigename.
  Heissen zwei Leute gleich, passiert nichts - dann zeigt die Meldung, woran
  sie sich unterscheiden, und man nimmt den Anfang der Kennung.
  node admin.mjs einladung [notiz] [--tage 14]   Einen Code ausstellen

Ein Verwalter darf Einladungen vergeben – sonst nichts. Fremde Daten lesen kann
auch er nicht: der Server selbst kann es nicht.
`);
}
