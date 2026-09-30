// Was zwischen Client und Server über die Leitung geht - nur Typen, damit
// beide Seiten dieselbe Form prüfen.

/** Ein Datensatz, wie ihn der Server ausliefert. */
export interface ServerRecord {
	id: string;
	kind: string;
	bucket: string | null;
	seq: number;
	rev: number;
	updatedAt: number;
	deviceId: string | null;
	deletedAt: number | null;
	/** Chiffrat, base64. Null bei einer Löschung. */
	payload: string | null;
}

/** Ein Datensatz, wie ihn ein Gerät ablegen will. */
export interface PushRecord {
	id: string;
	kind: string;
	bucket?: string | null;
	/** Die Fassung, die dieses Gerät zuletzt gesehen hat. 0 = "gibt es noch nicht". */
	baseRev: number;
	updatedAt: number;
	deletedAt?: number | null;
	payload?: string | null;
}

export interface PullPage {
	records: ServerRecord[];
	/** Der Stand, ab dem beim nächsten Mal weitergelesen wird. */
	nextSeq: number;
	/** Ob noch mehr da ist - der Aufrufer holt dann die nächste Seite. */
	hasMore: boolean;
}

export interface PushConflict {
	id: string;
	/** Was auf dem Server steht. Der Client führt zusammen und schickt erneut. */
	current: ServerRecord;
}

export interface PushAnswer {
	/** Ids, die übernommen wurden - mit ihrer neuen Fassung. */
	accepted: { id: string; rev: number; seq: number }[];
	conflicts: PushConflict[];
	/** Der höchste vergebene Stand; damit weckt der Ereigniskanal die anderen. */
	seq: number;
}

export interface BackupInfo {
	name: string;
	size: number;
	mtime: number;
	verified: boolean;
}

export interface TeamActivity {
	id: string;
	name: string;
	isAbsence: boolean;
	sortOrder: number;
	color: string | null;
	archived: boolean;
	updatedAt: number;
}

export interface TeamActivityInput {
	/** Fehlt sie, vergibt der Server eine neue - so entsteht eine Zeile. */
	id?: string;
	name: string;
	isAbsence: boolean;
	sortOrder: number;
	color?: string | null;
	archived: boolean;
}

export interface TeamReportStatus {
	memberId: string;
	memberName: string;
	memberEmail: string | null;
	/** null = für den abgefragten Monat noch nichts eingegangen. */
	submittedAt: number | null;
	/** Dem Transport nach undurchsichtig; die Form prüft sanitizeTeamReport auf dem Server. */
	payload: unknown | null;
}

/** Die Arten verpackter Schlüssel, die /api/wraps annimmt. */
export type WrapKind = "recovery" | "passkey";
