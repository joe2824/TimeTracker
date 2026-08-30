// Verwaltung von der Kommandozeile - im Container.
//
// Bewusst kein Endpunkt: der waere dauerhaft im Netz erreichbar, dieses Skript
// nur, solange jemand es aufruft.
//
//   docker compose exec timetracker node admin.mjs liste
//   docker compose exec timetracker node admin.mjs ernenne <id-oder-name>
//   docker compose exec timetracker node admin.mjs entziehe <id-oder-name>
//   docker compose exec timetracker node admin.mjs einladung [notiz] [--tage 14]
import Database from "better-sqlite3";
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DATEI = process.env.DB_FILE ?? `${process.env.DATA_DIR ?? "/data"}/timetracker.db`;
const db = new Database(DATEI);

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const neuerCode = () =>
	Array.from({ length: 4 }, () =>
		Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")
	).join("-");

const datum = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "–");

/** Die Platzhalter von LIKE entwerten - ein "%" in der Suche traefe sonst alles. */
const escapeLike = (s) => s.replace(/[\\%_]/g, "\\$&");

/** Ein Konto finden - ueber die Kennung, ihren Anfang, oder den Anzeigenamen. */
function findeKonto(suche) {
	const genau = db.prepare("SELECT * FROM users WHERE id = ?").get(suche);
	if (genau) return { treffer: [genau] };

	const nachName = db.prepare("SELECT * FROM users WHERE lower(display_name) = lower(?)").all(suche);

	// Der Anfang der Kennung. Ab vier Zeichen, sonst trifft es zu leicht mehrere.
	const nachPraefix =
		suche.length >= 4
			? db
					.prepare("SELECT * FROM users WHERE id LIKE ? ESCAPE '\\'")
					.all(`${escapeLike(suche)}%`)
			: [];

	const treffer = [...nachName];
	for (const k of nachPraefix) if (!treffer.some((t) => t.id === k.id)) treffer.push(k);
	return { treffer };
}

/** Woran man zwei gleichnamige Konten auseinanderhaelt. */
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
		const name = k.display_name && k.display_name !== k.id ? k.display_name : "–";
		console.log(
			`  ${k.is_admin ? "[Verwalter]" : "[         ]"}  ${name.padEnd(20)}  ID: ${k.id}`
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
		const deaktiviert = envInvitesDeaktiviert();
		if (deaktiviert) {
			console.log(`\nHinweis: ${ausUmgebung.length} Code(s) in INVITE_CODES (.env) sind DEAKTIVIERT (gesperrt).`);
		} else {
			console.log(`\nAchtung: ${ausUmgebung.length} Code(s) stehen in INVITE_CODES (.env) und sind AKTIV.`);
			console.log("Sie können in der App oder mit 'tt env-invites disable' deaktiviert werden.");
		}
	}
	console.log("");
}

function envInvitesDeaktiviert() {
	try {
		const zeile = db.prepare("SELECT value FROM server_settings WHERE key = 'env_invites_disabled'").get();
		return zeile?.value === "true";
	} catch {
		return false;
	}
}

function setzeEnvInvitesDeaktiviert(deaktiviert) {
	try {
		db.prepare("CREATE TABLE IF NOT EXISTS server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)").run();
		db.prepare("INSERT INTO server_settings (key, value, updated_at) VALUES ('env_invites_disabled', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(deaktiviert ? "true" : "false", Date.now());
		console.log(`\n  Statische Einladungscodes (.env) sind jetzt ${deaktiviert ? "DEAKTIVIERT" : "AKTIVIERT"}.\n`);
	} catch (e) {
		console.error("Fehler beim Ändern der Servereinstellung:", e.message);
	}
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
	let tage = 0;
	const bereinigt = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--tage" || argv[i] === "--days" || argv[i] === "-d") {
			tage = Number(argv[++i]) || 0;
		} else {
			bereinigt.push(argv[i]);
		}
	}
	const notiz = bereinigt.join(" ") || null;

	const code = neuerCode();
	db.prepare(
		"INSERT INTO invites (code, created_at, created_by, note, expires_at) VALUES (?,?,?,?,?)"
	).run(code, Date.now(), null, notiz, tage > 0 ? Date.now() + tage * 86_400_000 : null);
	console.log(`\n  ${code}\n`);
	console.log(tage > 0 ? `  Gilt ${tage} Tage, genau einmal.` : "  Gilt unbegrenzt, genau einmal.");
	if (notiz) console.log(`  Notiz: ${notiz}`);
	console.log("");
}

function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function zeigeSicherungen() {
	const dir = process.env.BACKUP_DIR ?? `${process.env.DATA_DIR ?? "/data"}/backups`;
	if (!existsSync(dir)) {
		console.log("\nNoch keine Sicherungen vorhanden.\n");
		return;
	}
	const dateien = readdirSync(dir)
		.filter((f) => f.endsWith(".db"))
		.map((f) => {
			const voll = join(dir, f);
			const st = statSync(voll);
			return { name: f, pfad: voll, bytes: st.size, mtime: st.mtimeMs };
		})
		.sort((a, b) => b.mtime - a.mtime);

	if (dateien.length === 0) {
		console.log("\nNoch keine Sicherungen vorhanden.\n");
		return;
	}
	console.log(`\nVorhandene Sicherungen in ${dir} (${dateien.length}):\n`);
	for (const d of dateien) {
		console.log(`  ${d.name.padEnd(46)}  ${datum(d.mtime)}   ${formatBytes(d.bytes)}`);
	}
	console.log("");
}

async function backup(argv) {
	if (argv[0] === "list" || argv[0] === "liste") {
		zeigeSicherungen();
		return;
	}
	const dir = process.env.BACKUP_DIR ?? `${process.env.DATA_DIR ?? "/data"}/backups`;
	mkdirSync(dir, { recursive: true });

	const pad = (n) => String(n).padStart(2, "0");
	const d = new Date();
	const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
	const standardPfad = join(dir, `timetracker-backup-${stamp}.db`);
	const ziel = argv[0] || standardPfad;
	try {
		await db.backup(ziel);
		console.log(`\n  Sicherung erfolgreich erstellt:\n  ${ziel}\n`);
	} catch (err) {
		console.error(`\n  Fehler bei der Sicherung: ${err.message}\n`);
		process.exit(1);
	}
}

function benenneUm(suche, neuerName) {
	if (!suche || !neuerName) {
		console.error("\nVerwendung: tt rename <id-oder-name> <neuer-name>\n");
		process.exit(1);
	}
	const { treffer } = findeKonto(suche);
	if (treffer.length === 0) {
		console.error(`\nKein Konto gefunden für "${suche}". "tt users" zeigt alle.\n`);
		process.exit(1);
	}
	if (treffer.length > 1) {
		console.error(`\nMehrdeutig – ${treffer.length} Konten passen auf "${suche}". Bitte eindeutige ID angeben.\n`);
		process.exit(1);
	}
	const k = treffer[0];
	const saubererName = neuerName.trim().slice(0, 64);
	db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(saubererName, k.id);
	console.log(`\n  Konto ${k.id} wurde von "${k.display_name}" in "${saubererName}" umbenannt.\n`);
}

const [befehl, ...rest] = process.argv.slice(2);
switch (befehl) {
	case "liste":
	case "list":
	case "users":
	case "konten":
		liste();
		break;
	case "rename":
	case "umbenennen":
	case "name":
		benenneUm(rest[0], rest.slice(1).join(" "));
		break;
	case "ernenne":
	case "promote":
	case "admin":
		if (rest[0] === "remove" || rest[0] === "revoke" || rest[0] === "entziehe") {
			setzeRolle(rest[1], false);
		} else {
			const ziel = rest[0] === "add" ? rest[1] : rest[0];
			setzeRolle(ziel, true);
		}
		break;
	case "entziehe":
	case "demote":
	case "unadmin":
		setzeRolle(rest[0], false);
		break;
	case "einladung":
	case "invite":
	case "code":
		einladung(rest);
		break;
	case "backup":
	case "sicherung":
		await backup(rest);
		break;
	case "backups":
	case "sicherungen":
		zeigeSicherungen();
		break;
	case "env-invites":
	case "tuerklinke":
		if (rest[0] === "disable" || rest[0] === "aus" || rest[0] === "deaktivieren") {
			setzeEnvInvitesDeaktiviert(true);
		} else if (rest[0] === "enable" || rest[0] === "an" || rest[0] === "aktivieren") {
			setzeEnvInvitesDeaktiviert(false);
		} else {
			const aus = envInvitesDeaktiviert();
			console.log(`\nStatische Einladungscodes (.env) sind aktuell: ${aus ? "DEAKTIVIERT" : "AKTIV"}`);
			console.log(`  Befehle: tt env-invites disable | tt env-invites enable\n`);
		}
		break;
	default:
		console.log(`
Verwaltung des TimeTracker-Servers.

  tt invite [notiz] [--days 14]            Einladungscode erstellen
  tt list / tt users                       Konten und Einladungen anzeigen
  tt rename <wer> <neuer-name>             Anzeigenamen eines Kontos ändern
  tt admin <wer> / tt promote <wer>        Zum Verwalter ernennen
  tt unadmin <wer> / tt demote <wer>       Verwalterrolle entziehen
  tt env-invites [disable|enable]          Statische .env-Codes de-/aktivieren
  tt backup [zieldatei]                    Datenbank online und atomar sichern
  tt backups                               Vorhandene Datenbanksicherungen anzeigen

  <wer> ist die Benutzerkennung (oder Präfix ab 4 Zeichen) oder der Anzeigename.
`);
}
