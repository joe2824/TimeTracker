// Das Schema des Servers.
//
// Im Klartext steht nur, was das Abgleichen selbst braucht: userId, kind, bucket
// (verschleierter Monat), seq, rev, updatedAt, deviceId. NICHT im Klartext: welcher
// Monat, welche Aktivität, wie lange, welche Notiz - und kein Zeitstempel.
import { blob, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Ein Konto. Kein Name, kein Pflicht-Postfach - zur Anmeldung reicht ein Passkey. */
export const users = sqliteTable("users", {
	id: text("id").primaryKey(),
	displayName: text("display_name").notNull(),
	/** Freiwillig und nur für den Zugang, nie für die Daten. */
	email: text("email"),
	createdAt: integer("created_at").notNull(),
	/** Laufende Nummer der Datensätze dieses Kontos. Siehe `records.seq`. */
	seqCounter: integer("seq_counter").notNull().default(0),
	/**
	 * Darf Einladungen vergeben - mehr nicht, insbesondere keine fremden Daten
	 * lesen (das kann auch der Server selbst nicht).
	 */
	isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
	/** Unter welcher Kennung dieses Konto seine Phrasen-Verpackung findet. */
	recoveryId: text("recovery_id"),
	/** Der Nachweis, dass jemand den Vault-Schlüssel wirklich hat - abgelegt nur als Hash. */
	vaultProof: text("vault_proof")
});

/** Ein Passkey. Ein Konto kann beliebig viele haben - je Gerät einen. */
export const credentials = sqliteTable(
	"credentials",
	{
		id: text("id").primaryKey(), // credentialID, base64url
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		publicKey: blob("public_key", { mode: "buffer" }).$type<Buffer>().notNull(),
		counter: integer("counter").notNull().default(0),
		transports: text("transports"),
		/** Wie der Mensch diesen Passkey nennt - "Laptop", "Handy", "Stick". */
		label: text("label"),
		createdAt: integer("created_at").notNull(),
		lastUsedAt: integer("last_used_at")
	},
	(t) => [index("credentials_user").on(t.userId)]
);

/** Die verpackten Vault-Schlüssel - für den Server undurchsichtige Bytes. */
export const keyWraps = sqliteTable(
	"key_wraps",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		kind: text("kind").$type<"recovery" | "passkey">().notNull(),
		/** Bei "passkey": zu welchem Passkey die Verpackung gehört. */
		credentialId: text("credential_id"),
		payload: text("payload").notNull(), // JSON mit base64-Feldern
		createdAt: integer("created_at").notNull()
	},
	(t) => [index("key_wraps_user").on(t.userId)]
);

/** Ein bekanntes Gerät. Einzeln widerrufbar, ohne die anderen anzutasten. */
export const devices = sqliteTable(
	"devices",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		label: text("label").notNull(),
		/** Nur der Hash - ein gestohlener Datenbestand gibt keine gültigen Token her. */
		tokenHash: text("token_hash").notNull(),
		createdAt: integer("created_at").notNull(),
		lastSeenAt: integer("last_seen_at"),
		revokedAt: integer("revoked_at")
	},
	(t) => [index("devices_user").on(t.userId), uniqueIndex("devices_token").on(t.tokenHash)]
);

/** Ein versiegelter Datensatz. */
export const records = sqliteTable(
	"records",
	{
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		id: text("id").notNull(),
		kind: text("kind").notNull(),
		bucket: text("bucket"),
		seq: integer("seq").notNull(),
		rev: integer("rev").notNull(),
		updatedAt: integer("updated_at").notNull(),
		deviceId: text("device_id"),
		deletedAt: integer("deleted_at"),
		/** Chiffrat samt Zufallswert, base64. Null bei einer Löschung. */
		payload: text("payload")
	},
	(t) => [
		// Eine Zeile je Datensatz, `seq` wandert beim Schreiben hoch - keine Historie.
		// Daraus folgt die Invariante, an der der gestufte Abgleich haengt: ein Cursor
		// kann ZU ALT sein (liefert redundant), nie ZU NEU (verpasst nichts). Deshalb
		// duerfen Datensaetze ausser der Reihe ankommen; `mergeRecord` entscheidet
		// ueber updatedAt/deviceId und ist idempotent.
		uniqueIndex("records_pk").on(t.userId, t.id),
		// Der eine heisse Pfad: jeder Abgleich ist ein Bereichsscan hierüber.
		index("records_seq").on(t.userId, t.seq),
		// Gezieltes Nachladen eines Zeitraums beim ersten Abgleich - mit `seq`, weil
		// auch der Bucket-Abruf der Reihe nach läuft.
		index("records_bucket_seq").on(t.userId, t.bucket, t.seq)
	]
);

/** Eine Browser-Sitzung. Der Desktop nutzt stattdessen ein Geräte-Token. */
export const sessions = sqliteTable(
	"sessions",
	{
		id: text("id").primaryKey(), // Hash des Cookie-Werts
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		createdAt: integer("created_at").notNull(),
		expiresAt: integer("expires_at").notNull()
	},
	(t) => [index("sessions_user").on(t.userId)]
);

/** Ein laufender WebAuthn-Vorgang. */
export const challenges = sqliteTable("challenges", {
	id: text("id").primaryKey(),
	challenge: text("challenge").notNull(),
	/** Bei der Anmeldung bekannt, bei der Registrierung noch nicht. */
	userId: text("user_id"),
	purpose: text("purpose").$type<"register" | "login" | "delete" | "addkey">().notNull(),
	expiresAt: integer("expires_at").notNull()
});

/** Einladungscodes. */
export const invites = sqliteTable("invites", {
	code: text("code").primaryKey(),
	createdAt: integer("created_at").notNull(),
	usedAt: integer("used_at"),
	usedBy: text("used_by"),
	/** Wer ihn ausgestellt hat. Null = aus der Umgebung, nicht aus der Tabelle. */
	createdBy: text("created_by"),
	/** Wofür er gedacht war - eine Notiz für den Verwalter, sonst nichts. */
	note: text("note"),
	/** Ab wann er nicht mehr gilt. Null = unbegrenzt. */
	expiresAt: integer("expires_at"),
	/** Zurückgezogen, ohne die Zeile zu löschen - sonst wäre die Spur weg. */
	revokedAt: integer("revoked_at")
});

/** Ein Kopplungsvorgang: hier liegt kurzzeitig das Paket für ein neues Gerät. */
export const pairings = sqliteTable(
	"pairings",
	{
		code: text("code").primaryKey(),
		/** Erst gesetzt, wenn ein entsperrtes Gerät den Vorgang bestätigt hat. */
		userId: text("user_id"),
		/** Öffentlicher Schlüssel des neuen Geräts, base64. */
		publicKey: text("public_key").notNull(),
		label: text("label").notNull(),
		/**
		 * Hash des Abhol-Geheimnisses. Das Geheimnis selbst kennt nur das neue
		 * Gerät; ohne es holt niemand das Geräte-Token ab - auch wer den Code
		 * kennt nicht. Der Code ist zum Vergleichen da und darf sichtbar sein.
		 */
		claimHash: text("claim_hash"),
		/** Erst gesetzt, wenn ein entsperrtes Gerät den Schlüssel verpackt hat. */
		wrappedKey: text("wrapped_key"),
		deviceToken: text("device_token"),
		createdAt: integer("created_at").notNull(),
		expiresAt: integer("expires_at").notNull()
	},
	(t) => [index("pairings_user").on(t.userId)]
);

/** Servereinstellungen, die zur Laufzeit vom Verwalter geändert werden können. */
export const serverSettings = sqliteTable("server_settings", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
	updatedAt: integer("updated_at").notNull()
});

/**
 * Anonyme Telemetrie-Meldungen („aktiv"-Pings).
 * Höchstens ein Eintrag je (date, deviceId). Enthält nur Datum, anonyme Geräte-ID,
 * Version, Plattform und letzten Zeitstempel.
 */
export const telemetryPings = sqliteTable(
	"telemetry_pings",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		date: text("date").notNull(), // "YYYY-MM-DD"
		deviceId: text("device_id").notNull(),
		version: text("version").notNull(),
		platform: text("platform").notNull(), // "macos" | "windows" | "linux" | "web"
		lastSeenAt: integer("last_seen_at").notNull()
	},
	// Kein zweiter Index nur auf `date`: der hier fängt diese Abfragen mit ab.
	(t) => [uniqueIndex("telemetry_pings_date_device").on(t.date, t.deviceId)]
);

/**
 * Ein Team. Der Chef ist ein normales Konto (`ownerUserId`) - keine eigene
 * Identität dafür. Kein Unique-Constraint auf `ownerUserId`: ein Chef kann
 * mehrere Teams führen.
 */
export const teams = sqliteTable(
	"teams",
	{
		id: text("id").primaryKey(),
		ownerUserId: text("owner_user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		createdAt: integer("created_at").notNull()
	},
	(t) => [index("teams_owner").on(t.ownerUserId)]
);

/** Ein Einladungslink für ein Team - mehrfach nutzbar, anders als ein Konto-Invite. */
export const teamInvites = sqliteTable(
	"team_invites",
	{
		code: text("code").primaryKey(),
		teamId: text("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		createdAt: integer("created_at").notNull(),
		expiresAt: integer("expires_at"),
		revokedAt: integer("revoked_at")
	},
	(t) => [index("team_invites_team").on(t.teamId)]
);

/**
 * Ein Team-Mitglied. Eigener Token-Raum, komplett getrennt von `devices`/
 * `users` - Mitglieder brauchen kein verschlüsseltes Personenkonto.
 */
export const teamMembers = sqliteTable(
	"team_members",
	{
		id: text("id").primaryKey(),
		teamId: text("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		tokenHash: text("token_hash").notNull(),
		createdAt: integer("created_at").notNull(),
		lastSeenAt: integer("last_seen_at"),
		revokedAt: integer("revoked_at")
	},
	(t) => [
		index("team_members_team").on(t.teamId),
		uniqueIndex("team_members_token").on(t.tokenHash)
	]
);

/** Der Zeitpunkt "jetzt" in der Einheit, die alle Tabellen benutzen. */
export const now = () => Date.now();

