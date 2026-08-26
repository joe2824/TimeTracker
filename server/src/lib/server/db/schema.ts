// Das Schema des Servers.
//
// Im Klartext steht nur, was das Abgleichen selbst braucht: userId, kind, bucket
// (verschleierter Monat), seq, rev, updatedAt, deviceId. NICHT im Klartext: welcher
// Monat, welche Aktivitaet, wie lange, welche Notiz - und kein Zeitstempel.
import { blob, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Ein Konto. Kein Name, kein Pflicht-Postfach - zur Anmeldung reicht ein Passkey. */
export const users = sqliteTable("users", {
	id: text("id").primaryKey(),
	displayName: text("display_name").notNull(),
	/** Freiwillig und nur fuer den Zugang, nie fuer die Daten. */
	email: text("email"),
	createdAt: integer("created_at").notNull(),
	/** Laufende Nummer der Datensaetze dieses Kontos. Siehe `records.seq`. */
	seqCounter: integer("seq_counter").notNull().default(0),
	/**
	 * Darf Einladungen vergeben - mehr nicht, insbesondere keine fremden Daten
	 * lesen (das kann auch der Server selbst nicht).
	 */
	isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
	/** Unter welcher Kennung dieses Konto seine Phrasen-Verpackung findet. */
	recoveryId: text("recovery_id"),
	/** Der Nachweis, dass jemand den Tresorschluessel wirklich hat - abgelegt nur als Hash. */
	vaultProof: text("vault_proof")
});

/** Ein Passkey. Ein Konto kann beliebig viele haben - je Geraet einen. */
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
		/** Ob dieser Authentifikator die PRF-Erweiterung kann - fuer die Anzeige. */
		hasPrf: integer("has_prf", { mode: "boolean" }).notNull().default(false),
		/** Wie der Mensch diesen Passkey nennt - "Laptop", "Handy", "Stick". */
		label: text("label"),
		createdAt: integer("created_at").notNull(),
		lastUsedAt: integer("last_used_at")
	},
	(t) => [index("credentials_user").on(t.userId)]
);

/** Die verpackten Tresorschluessel - fuer den Server undurchsichtige Bytes. */
export const keyWraps = sqliteTable(
	"key_wraps",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		kind: text("kind").$type<"recovery" | "passkey" | "device">().notNull(),
		/** Bei "passkey": zu welchem Passkey die Verpackung gehoert. */
		credentialId: text("credential_id"),
		payload: text("payload").notNull(), // JSON mit base64-Feldern
		createdAt: integer("created_at").notNull()
	},
	(t) => [index("key_wraps_user").on(t.userId)]
);

/** Ein bekanntes Geraet. Einzeln widerrufbar, ohne die anderen anzutasten. */
export const devices = sqliteTable(
	"devices",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		label: text("label").notNull(),
		/** Nur der Hash - ein gestohlener Datenbestand gibt keine gueltigen Token her. */
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
		/** Chiffrat samt Zufallswert, base64. Null bei einer Loeschung. */
		payload: text("payload")
	},
	(t) => [
		uniqueIndex("records_pk").on(t.userId, t.id),
		// Der eine heisse Pfad: jeder Abgleich ist ein Bereichsscan hierueber.
		index("records_seq").on(t.userId, t.seq),
		// Gezieltes Nachladen eines Zeitraums beim ersten Abgleich.
		index("records_bucket").on(t.userId, t.bucket)
	]
);

/** Eine Browser-Sitzung. Der Desktop nutzt stattdessen ein Geraete-Token. */
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
	/** Wofuer er gedacht war - eine Notiz fuer den Verwalter, sonst nichts. */
	note: text("note"),
	/** Ab wann er nicht mehr gilt. Null = unbegrenzt. */
	expiresAt: integer("expires_at"),
	/** Zurueckgezogen, ohne die Zeile zu loeschen - sonst waere die Spur weg. */
	revokedAt: integer("revoked_at")
});

/** Ein Kopplungsvorgang: hier liegt kurzzeitig das Paket fuer ein neues Geraet. */
export const pairings = sqliteTable(
	"pairings",
	{
		code: text("code").primaryKey(),
		/** Erst gesetzt, wenn ein entsperrtes Geraet den Vorgang bestaetigt hat. */
		userId: text("user_id"),
		/** Oeffentlicher Schluessel des neuen Geraets, base64. */
		publicKey: text("public_key").notNull(),
		label: text("label").notNull(),
		/** Erst gesetzt, wenn ein entsperrtes Geraet den Schluessel verpackt hat. */
		wrappedKey: text("wrapped_key"),
		deviceToken: text("device_token"),
		createdAt: integer("created_at").notNull(),
		expiresAt: integer("expires_at").notNull()
	},
	(t) => [index("pairings_user").on(t.userId)]
);

/** Der Zeitpunkt "jetzt" in der Einheit, die alle Tabellen benutzen. */
export const now = () => Date.now();
