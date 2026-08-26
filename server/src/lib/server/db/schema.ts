// Das Schema des Servers.
//
// Es faellt auf, wie wenig hier steht - und das ist der Punkt. Weil der Server
// nichts entschluesseln kann, gibt es keine Eintraege, keine Aktivitaeten, keine
// Stunden und keine Auswertung. Es gibt Konten, ihre Anmeldeverfahren, und einen
// Haufen versiegelter Datensaetze mit gerade so viel Klartext, wie das Abgleichen
// selbst braucht.
//
// Was im Klartext steht und warum:
//   userId    - ohne Zuordnung kein Mehrbenutzerbetrieb
//   kind      - der Client muss wissen, was er zu entschluesseln versucht
//   bucket    - verschleierter Monat, damit gezielt nachgeladen werden kann
//   seq       - die Reihenfolge, ueber die abgeglichen wird
//   rev       - damit zwei Geraete sich nicht gegenseitig ueberschreiben
//   updatedAt - fuer die Zusammenfuehrung auf dem Client
//   deviceId  - damit ein Geraet seine eigenen Aenderungen wiedererkennt
//
// NICHT im Klartext: welcher Monat, welche Aktivitaet, wie lange, welche Notiz,
// wie viele Stunden. Und kein Zeitstempel eines Eintrags.
import { blob, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Ein Konto.
 *
 * Kein Name, kein Pflicht-Postfach: zur Anmeldung reicht ein Passkey. Das
 * Anzeigefeld ist frei waehlbar und dient nur dazu, im Anmeldedialog des
 * Betriebssystems etwas Sinnvolles stehen zu haben.
 */
export const users = sqliteTable("users", {
	id: text("id").primaryKey(),
	displayName: text("display_name").notNull(),
	/**
	 * Freiwillig und nur fuer den Zugang, nie fuer die Daten.
	 *
	 * Ein Magic-Link stellt den KONTOzugang wieder her - einen neuen Passkey
	 * anlegen. Entschluesseln laesst sich damit nichts: dafuer braucht es
	 * weiterhin die Phrase oder ein entsperrtes Geraet.
	 */
	email: text("email"),
	createdAt: integer("created_at").notNull(),
	/** Laufende Nummer der Datensaetze dieses Kontos. Siehe `records.seq`. */
	seqCounter: integer("seq_counter").notNull().default(0),
	/**
	 * Darf Einladungen vergeben.
	 *
	 * Mehr nicht - und ausdruecklich NICHT: fremde Daten lesen. Das kann auch ein
	 * Verwalter nicht, weil der Server es selbst nicht kann. Die Rolle regelt, wer
	 * hereindarf, nicht wer etwas sieht.
	 *
	 * Der erste Verwalter wird im Container gesetzt (siehe admin.mjs). Bewusst
	 * kein "der erste Angemeldete wird es automatisch": bei einem Dienst, der
	 * spaeter offen laufen soll, waere das ein Wettrennen.
	 */
	isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
	/**
	 * Unter welcher Kennung dieses Konto seine Phrasen-Verpackung findet.
	 *
	 * Ein Hash ueber die Wiederherstellungs-Phrase (siehe recoveryLookupId in
	 * src/lib/crypto/vault.ts). Er verraet sie nicht und oeffnet nichts - er sagt
	 * nur, WELCHES Konto gemeint ist, wenn jemand mit nichts als den 24 Woertern
	 * dasteht.
	 */
	recoveryId: text("recovery_id"),
	/**
	 * Der Nachweis, dass jemand den Tresorschluessel wirklich hat.
	 *
	 * HMAC ueber einen festen Text mit dem Tresorschluessel. Der Server kennt den
	 * Schluessel nicht und lernt ihn hieraus auch nicht - er kann aber pruefen, ob
	 * jemand die Verpackung tatsaechlich geoeffnet hat, bevor er ein Geraet
	 * anmeldet. Ohne das genuegte die Kennung oben, und wer sie aus einer
	 * gestohlenen Datenbank abliest, bekaeme Zugriff auf alle Chiffrate.
	 */
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
		/**
		 * Wie der Mensch diesen Passkey nennt - "Laptop", "Handy", "Stick".
		 *
		 * Ohne das steht in der Liste eine base64-Kennung, und niemand weiss, welche
		 * davon der alte Rechner war, den er gerade entsorgt hat. Genau dann braucht
		 * man die Liste aber.
		 */
		label: text("label"),
		createdAt: integer("created_at").notNull(),
		lastUsedAt: integer("last_used_at")
	},
	(t) => [index("credentials_user").on(t.userId)]
);

/**
 * Die verpackten Tresorschluessel.
 *
 * Fuer den Server sind das undurchsichtige Bytes. Er verwahrt sie nur, damit ein
 * neues Geraet sie abholen kann - entpacken kann sie ausschliesslich, wer die
 * Phrase, den Passkey oder den privaten Geraeteschluessel hat.
 */
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

/**
 * Ein versiegelter Datensatz.
 *
 * `seq` ist die laufende Nummer INNERHALB eines Kontos, nicht ueber alle: sonst
 * verriete der Abstand zweier Nummern, wie viel andere Konten dazwischen
 * geschrieben haben. Sie steigt bei jeder Aenderung und ist der Anker des
 * Abgleichs - "gib mir alles ab Nummer N".
 *
 * `rev` steigt je Datensatz. Wer mit einer veralteten rev schreibt, wird
 * abgewiesen: so kann ein Geraet die Aenderung eines anderen nicht
 * ueberschreiben, ohne sie gesehen zu haben.
 */
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

/**
 * Ein laufender WebAuthn-Vorgang.
 *
 * Die Aufgabe muss zwischen "start" und "finish" irgendwo liegen und darf nur
 * einmal gelten. In der Datenbank statt im Prozessgedaechtnis, damit spaeter
 * eine zweite Instanz danebenlaufen kann, ohne dass Anmeldungen scheitern.
 */
export const challenges = sqliteTable("challenges", {
	id: text("id").primaryKey(),
	challenge: text("challenge").notNull(),
	/** Bei der Anmeldung bekannt, bei der Registrierung noch nicht. */
	userId: text("user_id"),
	purpose: text("purpose").$type<"register" | "login" | "delete" | "addkey">().notNull(),
	expiresAt: integer("expires_at").notNull()
});

/**
 * Einladungscodes.
 *
 * Solange es welche gibt, ist die Registrierung geschlossen. Genau so faengt
 * der Dienst an: mehrbenutzerfaehig gebaut, aber nicht offen.
 */
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

/**
 * Ein Kopplungsvorgang: hier liegt kurzzeitig das Paket fuer ein neues Geraet.
 *
 * Der Server sieht dabei nur Chiffrat. Das Paket ist kurzlebig und wird nach dem
 * Abholen geloescht - ein liegen gebliebenes Paket waere ein Angriffsziel ohne
 * jeden Nutzen.
 */
export const pairings = sqliteTable(
	"pairings",
	{
		code: text("code").primaryKey(),
		/**
		 * Erst gesetzt, wenn ein entsperrtes Geraet den Vorgang bestaetigt hat.
		 *
		 * Bewusst ohne Fremdschluessel: der Vorgang beginnt auf dem NEUEN Geraet,
		 * also bevor ueberhaupt feststeht, zu welchem Konto er gehoeren wird.
		 */
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
