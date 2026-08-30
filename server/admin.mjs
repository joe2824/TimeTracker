// Command line administration for TimeTracker server (inside container).
//
// Examples:
//   docker compose exec timetracker node admin.mjs list
//   docker compose exec timetracker node admin.mjs promote <id-or-name>
//   docker compose exec timetracker node admin.mjs demote <id-or-name>
//   docker compose exec timetracker node admin.mjs rename <id-or-name> <new-name>
//   docker compose exec timetracker node admin.mjs invite [note] [--days 14]
import Database from "better-sqlite3";
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const dbFile = process.env.DB_FILE ?? `${process.env.DATA_DIR ?? "/data"}/timetracker.db`;
const db = new Database(dbFile);

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const createInviteCode = () =>
	Array.from({ length: 4 }, () =>
		Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")
	).join("-");

const formatDate = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "–");

/** Escape LIKE query wildcards (% and _). */
const escapeLike = (str) => str.replace(/[\\%_]/g, "\\$&");

/** Find user account by exact ID, display name, or ID prefix (>= 4 chars). */
function findUser(query) {
	const exactMatch = db.prepare("SELECT * FROM users WHERE id = ?").get(query);
	if (exactMatch) return { matches: [exactMatch] };

	const byName = db.prepare("SELECT * FROM users WHERE lower(display_name) = lower(?)").all(query);
	const byPrefix =
		query.length >= 4
			? db
					.prepare("SELECT * FROM users WHERE id LIKE ? ESCAPE '\\'")
					.all(`${escapeLike(query)}%`)
			: [];

	const matches = [...byName];
	for (const candidate of byPrefix) {
		if (!matches.some((m) => m.id === candidate.id)) {
			matches.push(candidate);
		}
	}
	return { matches };
}

/** Get device and activity characteristics for disambiguating user accounts. */
function getUserFeatures(userId) {
	const devices = db
		.prepare("SELECT label, last_seen_at FROM devices WHERE user_id = ? AND revoked_at IS NULL")
		.all(userId);
	const recordCount = db.prepare("SELECT count(*) n FROM records WHERE user_id = ?").get(userId).n;
	const lastSeen = devices.reduce((max, d) => Math.max(max, d.last_seen_at ?? 0), 0);
	return {
		devices: devices.map((d) => d.label).join(", ") || "keine",
		recordCount,
		lastSeen
	};
}

function listUsers() {
	const users = db
		.prepare("SELECT id, display_name, is_admin, created_at FROM users ORDER BY created_at")
		.all();
	if (users.length === 0) {
		console.log("Noch keine Konten. Der erste Mensch registriert sich über die Weboberfläche –");
		console.log("mit einem Code aus INVITE_CODES. Danach hier zum Verwalter ernennen.");
		return;
	}
	console.log("\nKonten:\n");
	for (const user of users) {
		const features = getUserFeatures(user.id);
		const name = user.display_name && user.display_name !== user.id ? user.display_name : "–";
		console.log(
			`  ${user.is_admin ? "[Verwalter]" : "[         ]"}  ${name.padEnd(20)}  ID: ${user.id}`
		);
		console.log(
			`                 seit ${formatDate(user.created_at)}   Geräte: ${features.devices}   Datensätze: ${features.recordCount}`
		);
	}

	const codes = db.prepare("SELECT * FROM invites ORDER BY created_at DESC LIMIT 20").all();
	console.log(`\nEinladungen (${codes.length}):\n`);
	for (const invite of codes) {
		const status = invite.used_at
			? `benutzt ${formatDate(invite.used_at)}`
			: invite.revoked_at
				? "zurückgezogen"
				: invite.expires_at && invite.expires_at < Date.now()
					? "abgelaufen"
					: "offen";
		console.log(`  ${invite.code}  ${status.padEnd(22)} ${invite.note ?? ""}`);
	}

	const envCodes = (process.env.INVITE_CODES ?? "").split(",").filter(Boolean);
	if (envCodes.length > 0) {
		const isDisabled = isEnvInvitesDisabled();
		if (isDisabled) {
			console.log(`\nHinweis: ${envCodes.length} Code(s) in INVITE_CODES (.env) sind DEAKTIVIERT (gesperrt).`);
		} else {
			console.log(`\nAchtung: ${envCodes.length} Code(s) stehen in INVITE_CODES (.env) und sind AKTIV.`);
			console.log("Sie können in der App oder mit 'tt env-invites disable' deaktiviert werden.");
		}
	}
	console.log("");
}

function isEnvInvitesDisabled() {
	try {
		const row = db.prepare("SELECT value FROM server_settings WHERE key = 'env_invites_disabled'").get();
		return row?.value === "true";
	} catch {
		return false;
	}
}

function setEnvInvitesDisabled(disabled) {
	try {
		db.prepare("CREATE TABLE IF NOT EXISTS server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)").run();
		db.prepare("INSERT INTO server_settings (key, value, updated_at) VALUES ('env_invites_disabled', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(disabled ? "true" : "false", Date.now());
		console.log(`\n  Statische Einladungscodes (.env) sind jetzt ${disabled ? "DEAKTIVIERT" : "AKTIVIERT"}.\n`);
	} catch (e) {
		console.error("Fehler beim Ändern der Servereinstellung:", e.message);
	}
}

function setAdminRole(target, isAdmin) {
	const { matches } = findUser(target);
	if (matches.length === 0) {
		console.error(`Kein Konto gefunden für "${target}". "node admin.mjs list" zeigt alle.`);
		process.exit(1);
	}
	if (matches.length > 1) {
		console.error("");
		console.error(`Mehrdeutig – ${matches.length} Konten passen auf "${target}".`);
		console.error("");
		console.error("Welches gemeint ist, sagt am ehesten das Gerät oder der Zeitpunkt:");
		console.error("");
		for (const match of matches) {
			const features = getUserFeatures(match.id);
			console.error(`  ${match.display_name}`);
			console.error(`    Kennung     ${match.id}`);
			console.error(`    angelegt    ${formatDate(match.created_at)}`);
			console.error(`    Geräte      ${features.devices}`);
			console.error(`    zuletzt     ${features.lastSeen ? formatDate(features.lastSeen) : "nie verbunden"}`);
			console.error(`    Datensätze  ${features.recordCount}`);
			console.error("");
		}
		console.error(`Dann z. B.:  node admin.mjs promote ${matches[0].id.slice(0, 8)}`);
		console.error("");
		process.exit(1);
	}
	const user = matches[0];
	db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(isAdmin ? 1 : 0, user.id);
	console.log(
		`${user.display_name} (${user.id}) ist ${isAdmin ? "jetzt Verwalter" : "kein Verwalter mehr"}.`
	);
	if (!isAdmin) {
		const remainingAdmins = db.prepare("SELECT count(*) n FROM users WHERE is_admin = 1").get().n;
		if (remainingAdmins === 0) {
			console.log("\nHinweis: Es gibt jetzt KEINEN Verwalter mehr. Einladungen lassen sich");
			console.log("nur noch hier ausstellen, nicht mehr über die Oberfläche.");
		}
	}
}

function createInvite(argv) {
	let days = 0;
	const cleanArgs = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--tage" || argv[i] === "--days" || argv[i] === "-d") {
			days = Number(argv[++i]) || 0;
		} else {
			cleanArgs.push(argv[i]);
		}
	}
	const note = cleanArgs.join(" ") || null;
	const code = createInviteCode();
	db.prepare(
		"INSERT INTO invites (code, created_at, created_by, note, expires_at) VALUES (?,?,?,?,?)"
	).run(code, Date.now(), null, note, days > 0 ? Date.now() + days * 86_400_000 : null);
	console.log(`\n  ${code}\n`);
	console.log(days > 0 ? `  Gilt ${days} Tage, genau einmal.` : "  Gilt unbegrenzt, genau einmal.");
	if (note) console.log(`  Notiz: ${note}`);
	console.log("");
}

function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function listBackups() {
	const backupDir = process.env.BACKUP_DIR ?? `${process.env.DATA_DIR ?? "/data"}/backups`;
	if (!existsSync(backupDir)) {
		console.log("\nNoch keine Sicherungen vorhanden.\n");
		return;
	}
	const backupFiles = readdirSync(backupDir)
		.filter((f) => f.endsWith(".db"))
		.map((f) => {
			const fullPath = join(backupDir, f);
			const stat = statSync(fullPath);
			return { name: f, path: fullPath, size: stat.size, mtime: stat.mtimeMs };
		})
		.sort((a, b) => b.mtime - a.mtime);

	if (backupFiles.length === 0) {
		console.log("\nNoch keine Sicherungen vorhanden.\n");
		return;
	}
	console.log(`\nVorhandene Sicherungen in ${backupDir} (${backupFiles.length}):\n`);
	for (const file of backupFiles) {
		console.log(`  ${file.name.padEnd(46)}  ${formatDate(file.mtime)}   ${formatBytes(file.size)}`);
	}
	console.log("");
}

async function createBackup(argv) {
	if (argv[0] === "list" || argv[0] === "liste") {
		listBackups();
		return;
	}
	const backupDir = process.env.BACKUP_DIR ?? `${process.env.DATA_DIR ?? "/data"}/backups`;
	mkdirSync(backupDir, { recursive: true });

	const pad = (n) => String(n).padStart(2, "0");
	const now = new Date();
	const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
	const defaultPath = join(backupDir, `timetracker-backup-${timestamp}.db`);
	const targetPath = argv[0] || defaultPath;
	try {
		await db.backup(targetPath);
		console.log(`\n  Sicherung erfolgreich erstellt:\n  ${targetPath}\n`);
	} catch (err) {
		console.error(`\n  Fehler bei der Sicherung: ${err.message}\n`);
		process.exit(1);
	}
}

function renameUser(target, newName) {
	if (!target || !newName) {
		console.error("\nVerwendung: tt rename <id-oder-name> <neuer-name>\n");
		process.exit(1);
	}
	const { matches } = findUser(target);
	if (matches.length === 0) {
		console.error(`\nKein Konto gefunden für "${target}". "tt users" zeigt alle.\n`);
		process.exit(1);
	}
	if (matches.length > 1) {
		console.error(`\nMehrdeutig – ${matches.length} Konten passen auf "${target}". Bitte eindeutige ID angeben.\n`);
		process.exit(1);
	}
	const user = matches[0];
	const cleanName = newName.trim().slice(0, 64);
	db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(cleanName, user.id);
	console.log(`\n  Konto ${user.id} wurde von "${user.display_name}" in "${cleanName}" umbenannt.\n`);
}

function showStatus() {
	console.log("\n=== TimeTracker Server Status ===");

	let dbSize = "–";
	try {
		const s = statSync(dbFile);
		dbSize = `${(s.size / 1024 / 1024).toFixed(2)} MB`;
	} catch {}
	console.log(`\nDatenbank:       ${dbFile} (${dbSize})`);

	const userCount = db.prepare("SELECT count(*) n FROM users").get()?.n ?? 0;
	const adminCount = db.prepare("SELECT count(*) n FROM users WHERE is_admin = 1").get()?.n ?? 0;
	const deviceCount = db.prepare("SELECT count(*) n FROM devices WHERE revoked_at IS NULL").get()?.n ?? 0;
	const recordCount = db.prepare("SELECT count(*) n FROM records").get()?.n ?? 0;
	const openInvites =
		db
			.prepare(
				"SELECT count(*) n FROM invites WHERE used_at IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)"
			)
			.get(Date.now())?.n ?? 0;

	console.log(`Benutzer:        ${userCount} (davon ${adminCount} Verwalter)`);
	console.log(`Aktive Geräte:   ${deviceCount}`);
	console.log(`Zeitsätze:       ${recordCount}`);
	console.log(`Offene Codes:    ${openInvites}`);
	console.log(`Registrierung:   ${isEnvInvitesDisabled() ? "Nur per Einladung (.env aus)" : "Statische .env-Codes aktiv"}`);

	const backupDir = join(process.env.DATA_DIR ?? "/data", "backups");
	let backupCount = 0;
	if (existsSync(backupDir)) {
		backupCount = readdirSync(backupDir).filter((f) => f.endsWith(".db")).length;
	}
	console.log(`Sicherungen:     ${backupCount} in ${backupDir}`);
	console.log(`Node-Version:    ${process.version} (${process.arch})`);
	console.log(`Speicher (RSS):  ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB\n`);
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
	case "status":
	case "info":
		showStatus();
		break;
	case "liste":
	case "list":
	case "users":
	case "konten":
		listUsers();
		break;
	case "rename":
	case "umbenennen":
	case "name":
		renameUser(args[0], args.slice(1).join(" "));
		break;
	case "ernenne":
	case "promote":
	case "admin":
		if (args[0] === "remove" || args[0] === "revoke" || args[0] === "entziehe") {
			setAdminRole(args[1], false);
		} else {
			const target = args[0] === "add" ? args[1] : args[0];
			setAdminRole(target, true);
		}
		break;
	case "entziehe":
	case "demote":
	case "unadmin":
		setAdminRole(args[0], false);
		break;
	case "einladung":
	case "invite":
	case "code":
		createInvite(args);
		break;
	case "backup":
	case "sicherung":
		await createBackup(args);
		break;
	case "backups":
	case "sicherungen":
		listBackups();
		break;
	case "env-invites":
	case "tuerklinke":
		if (args[0] === "disable" || args[0] === "aus" || args[0] === "deaktivieren") {
			setEnvInvitesDisabled(true);
		} else if (args[0] === "enable" || args[0] === "an" || args[0] === "aktivieren") {
			setEnvInvitesDisabled(false);
		} else {
			const disabled = isEnvInvitesDisabled();
			console.log(`\nStatische Einladungscodes (.env) sind aktuell: ${disabled ? "DEAKTIVIERT" : "AKTIV"}`);
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
