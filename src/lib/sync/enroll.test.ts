// Der Passkey muss die Daten allein oeffnen koennen - schon beim ersten Mal in
// einem neuen Browser. Die 24 Woerter sind der Weg zurueck, nicht der Weg hinein.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform/http", () => ({
	platformFetch: () => Promise.reject(new Error("kein Netz"))
}));
vi.mock("../log", () => ({ logWarn: () => {}, logInfo: () => {} }));

const webauthn = vi.hoisted(() => ({
	startRegistration: vi.fn(),
	startAuthentication: vi.fn()
}));
vi.mock("@simplewebauthn/browser", () => webauthn);

/** Nur so viel Server, wie Anlegen und Anmelden anfassen. */
const server = vi.hoisted(() => ({
	wraps: [] as { id: string; kind: string; credentialId: string | null; payload: string }[],
	/** Laeuft bei jedem Abruf der Verpackungen - fuer Aussagen ueber die Reihenfolge. */
	onWraps: (() => {}) as () => void,
	/** Wie oft eine Anmelde-Aufgabe geholt wurde - daran haengt der Puffer-Test. */
	loginStarts: 0
}));

vi.mock("./api", () => {
	class ApiError extends Error {
		constructor(
			public status: number,
			message: string
		) {
			super(message);
		}
	}
	class Api {
		registerStart() {
			return Promise.resolve({ challengeId: "c1", userId: "u1", options: {} });
		}
		/**
		 * Wie die echte Route: Konto, Passkey und beide Verpackungen entstehen in
		 * EINER Transaktion. Nur so faellt hier auf, wenn eine davon fehlt.
		 */
		registerFinish(body: {
			response: { id: string };
			recoveryWrap: { payload: string };
			passkeyWrap?: { payload: string } | null;
		}) {
			this.putWrap("recovery", body.recoveryWrap.payload);
			if (body.passkeyWrap) this.putWrap("passkey", body.passkeyWrap.payload, body.response.id);
			return Promise.resolve({ userId: "u1", displayName: "Test" });
		}
		loginStart() {
			server.loginStarts += 1;
			return Promise.resolve({ challengeId: "c2", options: {} });
		}
		loginFinish() {
			return Promise.resolve({ userId: "u1", displayName: "Test" });
		}
		wraps() {
			server.onWraps();
			return Promise.resolve({ wraps: server.wraps });
		}
		putWrap(kind: string, payload: string, credentialId?: string) {
			// Je Passkey genau eine Verpackung - wie in server/src/routes/api/wraps.
			server.wraps = server.wraps.filter(
				(w) => !(w.kind === kind && (kind !== "passkey" || w.credentialId === credentialId))
			);
			server.wraps.push({
				id: String(server.wraps.length),
				kind,
				credentialId: credentialId ?? null,
				payload
			});
			return Promise.resolve({ id: "w" });
		}
	}
	return { Api, ApiError };
});

const { register, login, prepareLogin, reunlockWithPasskey } = await import("./enroll");
const { Api } = await import("./api");
const { createVaultKey, exportVaultKey, wrapWithPrf } = await import("../crypto/vault");

/** Was der Authentifikator zurueckgibt. Ohne `prf`: kein Wert bei dieser Zeremonie. */
function response(id: string, prf: number[] | null) {
	return {
		id,
		clientExtensionResults: prf
			? { prf: { enabled: true, results: { first: Uint8Array.from(prf) } } }
			: { prf: { enabled: true } }
	};
}

const PRF = Array.from({ length: 32 }, (_, i) => i);

beforeEach(() => {
	server.wraps = [];
	server.onWraps = () => {};
	server.loginStarts = 0;
	webauthn.startRegistration.mockReset();
	webauthn.startAuthentication.mockReset();
});

describe("register", () => {
	it("legt die Passkey-Verpackung an, auch wenn das Anlegen keinen PRF-Wert hergibt", async () => {
		webauthn.startRegistration.mockResolvedValue(response("cred-a", null));
		// Die meisten Browser ruecken den Wert erst bei einer Anmeldung heraus.
		webauthn.startAuthentication.mockResolvedValue(response("cred-a", PRF));

		const r = await register("https://a.example", "");

		expect(r.prfAvailable).toBe(true);
		expect(webauthn.startAuthentication).toHaveBeenCalledTimes(1);
		expect(server.wraps.map((w) => w.kind).sort()).toEqual(["passkey", "recovery"]);
		expect(server.wraps.find((w) => w.kind === "passkey")?.credentialId).toBe("cred-a");
	});

	it("fragt nicht nach, wenn der Wert schon beim Anlegen dabei war", async () => {
		webauthn.startRegistration.mockResolvedValue(response("cred-b", PRF));

		const r = await register("https://b.example", "");

		expect(r.prfAvailable).toBe(true);
		expect(webauthn.startAuthentication).not.toHaveBeenCalled();
		expect(server.wraps.some((w) => w.kind === "passkey")).toBe(true);
	});

	it("legt das Konto auch an, wenn der Authentifikator kein PRF kann", async () => {
		webauthn.startRegistration.mockResolvedValue(response("cred-c", null));
		webauthn.startAuthentication.mockResolvedValue(response("cred-c", null));

		const r = await register("https://c.example", "");

		expect(r.prfAvailable).toBe(false);
		expect(r.recoveryPhrase?.split(" ")).toHaveLength(24);
		expect(server.wraps.map((w) => w.kind)).toEqual(["recovery"]);
	});
});

describe("login", () => {
	it("oeffnet die Daten mit dem Passkey, den register hinterlegt hat", async () => {
		webauthn.startRegistration.mockResolvedValue(response("cred-d", null));
		webauthn.startAuthentication.mockResolvedValue(response("cred-d", PRF));
		const created = await register("https://d.example", "");

		// Neuer Browser, derselbe (synchronisierte) Passkey.
		const r = await login("https://d.example");

		expect(r.key).not.toBeNull();
		expect(new Uint8Array(await exportVaultKey(r.key!))).toEqual(
			new Uint8Array(await exportVaultKey(created.key))
		);
	});

	it("holt die vorgeladene Aufgabe nur einmal und wirft sie danach weg", async () => {
		webauthn.startAuthentication.mockResolvedValue(response("cred-f", PRF));
		server.wraps = [{ id: "r", kind: "recovery", credentialId: null, payload: "{}" }];

		// Zeiger drauf, Finger drauf, Klick - trotzdem eine Anfrage.
		void prepareLogin("https://f.example");
		void prepareLogin("https://f.example");
		await login("https://f.example");
		expect(server.loginStarts).toBe(1);

		// Der Server hat die Aufgabe beim Nachsehen geloescht: die naechste
		// Anmeldung braucht eine neue.
		await login("https://f.example");
		expect(server.loginStarts).toBe(2);
	});

	it("neues Gerät, nur der Passkey - mehr braucht es nicht", async () => {
		// Genau der Fall, um den es geht: Konto woanders angelegt, hier liegt
		// nichts, der Passkey ist ueber die Cloud mitgekommen.
		webauthn.startRegistration.mockResolvedValue(response("cred-sync", null));
		webauthn.startAuthentication.mockResolvedValue(response("cred-sync", PRF));
		const created = await register("https://neu.example", "");

		webauthn.startRegistration.mockReset();
		webauthn.startAuthentication.mockClear();

		const r = await login("https://neu.example");

		expect(r.key).not.toBeNull();
		expect(new Uint8Array(await exportVaultKey(r.key!))).toEqual(
			new Uint8Array(await exportVaultKey(created.key))
		);
		// Eine einzige WebAuthn-Abfrage: die Anmeldung. Keine Phrase, kein Nachlauf.
		expect(webauthn.startAuthentication).toHaveBeenCalledTimes(1);
	});

	it("bleibt ohne Verpackung zu, verlangt dann aber die Phrase", async () => {
		webauthn.startAuthentication.mockResolvedValue(response("cred-e", PRF));
		server.wraps = [{ id: "r", kind: "recovery", credentialId: null, payload: "{}" }];

		const r = await login("https://e.example");

		expect(r.key).toBeNull();
		expect(r.canUnlockWithPhrase).toBe(true);
		expect(r.credentialId).toBe("cred-e");
		// Damit repariert unlockWithPhrase den Passkey gleich mit.
		expect(r.prf).not.toBeNull();
	});
});

describe("reunlockWithPasskey", () => {
	const api = new Api({ baseUrl: "https://r.example" });

	/** Die Kennungen, nach denen der Browser gefragt wurde. */
	function askedFor(): string[] {
		const options = webauthn.startAuthentication.mock.calls[0][0].optionsJSON;
		return (options.allowCredentials ?? []).map((c: { id: string }) => c.id);
	}

	it("fragt gar nicht erst, wenn kein Passkey die Daten öffnen kann", async () => {
		// Der Kreis, um den es geht: wer eine FEHLENDE Verpackung nachtragen will,
		// wurde bisher nach genau dem Passkey gefragt, der nichts oeffnen kann.
		await expect(
			reunlockWithPasskey(api, { preferred: "cred-ohne", usableIds: [] })
		).rejects.toThrow(/24 Wörtern/);
		expect(webauthn.startAuthentication).not.toHaveBeenCalled();
	});

	it("holt die Verpackung erst NACH der Bestätigung", async () => {
		// Eine Anfrage zwischen Klick und Dialog kostet auf schmaler Leitung die
		// Berechtigung aus der Berührung - der Browser lehnt dann mit
		// NotAllowedError ab, und es sieht aus, als ginge der Passkey nicht mehr.
		const key = await createVaultKey();
		const order: string[] = [];
		server.wraps = [
			{
				id: "w",
				kind: "passkey",
				credentialId: "cred-mit",
				payload: await wrapWithPrf(key, Uint8Array.from(PRF))
			}
		];
		server.onWraps = () => order.push("wraps");
		webauthn.startAuthentication.mockImplementation(() => {
			order.push("dialog");
			return Promise.resolve(response("cred-mit", PRF));
		});

		await reunlockWithPasskey(api, { usableIds: ["cred-mit"] });

		expect(order).toEqual(["dialog", "wraps"]);
	});

	it("fragt nur nach den Passkeys, zu denen eine Verpackung liegt", async () => {
		const key = await createVaultKey();
		server.wraps = [
			{ id: "r", kind: "recovery", credentialId: null, payload: "{}" },
			{
				id: "w",
				kind: "passkey",
				credentialId: "cred-mit",
				payload: await wrapWithPrf(key, Uint8Array.from(PRF))
			}
		];
		webauthn.startAuthentication.mockResolvedValue(response("cred-mit", PRF));

		const back = await reunlockWithPasskey(api, {
			preferred: "cred-ohne",
			usableIds: ["cred-mit"]
		});

		expect(askedFor()).toEqual(["cred-mit"]);
		expect(new Uint8Array(await exportVaultKey(back))).toEqual(
			new Uint8Array(await exportVaultKey(key))
		);
	});

	it("nimmt den Passkey dieses Browsers, wenn der es kann", async () => {
		const key = await createVaultKey();
		const payload = await wrapWithPrf(key, Uint8Array.from(PRF));
		server.wraps = [
			{ id: "w1", kind: "passkey", credentialId: "cred-hier", payload },
			{ id: "w2", kind: "passkey", credentialId: "cred-woanders", payload }
		];
		webauthn.startAuthentication.mockResolvedValue(response("cred-hier", PRF));

		await reunlockWithPasskey(api, {
			preferred: "cred-hier",
			usableIds: ["cred-hier", "cred-woanders"]
		});

		expect(askedFor()).toEqual(["cred-hier"]);
	});
});
