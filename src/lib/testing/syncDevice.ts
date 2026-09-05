// Ein nachgestelltes Geraet fuer die Abgleich-Tests: eigener Dateibestand,
// eigener Abgleichstand, eigene Engine gegen den nachgebauten Server.
//
// Die Tests teilen sich EINE Ablage (`fakeFs`). Wer auf einem Geraet etwas tut,
// legt deshalb zuerst dessen Dateien auf und nimmt sie danach wieder mit -
// sonst saehe das naechste Geraet die Dateien des vorigen.
import * as store from "../store";
import { Api } from "../sync/api";
import { SyncEngine, type LocalStore, type SyncProgress, type SyncState } from "../sync/engine";
import { resetOutboxForTests, startTracking } from "../sync/outbox";
import { files, resetFakeFs } from "./fakeFs";
import type { FakeSyncServer } from "./fakeSyncServer";
import type { VaultKey } from "../crypto/vault";

export class FakeDevice {
	files = new Map<string, string>();
	state: SyncState = { seq: 0 };

	constructor(readonly id: string) {}
}

/** Womit die Engine dieses Geraets aufgebaut wird. */
export interface DeviceContext {
	server: FakeSyncServer;
	key: VaultKey;
	/** Die Fortschrittsmeldungen der Engine mitschneiden. */
	onProgress?: (progress: SyncProgress) => void;
}

/** Der lokale Speicher, so verdrahtet wie im Betrieb (`account.svelte.ts`). */
const localStore: LocalStore = {
	entriesOfMonth: (m) => store.loadEntries(m),
	saveEntries: (m, list) => store.saveEntries(m, list),
	activities: () => store.loadActivities(),
	saveActivities: (l) => store.saveActivities(l),
	settings: () => store.loadSettings(),
	saveSettings: (s) => store.saveSettings(s),
	timeReport: (m) => store.loadTimeReport(m),
	saveTimeReport: (r) => store.saveTimeReport(r),
	deleteTimeReport: (m) => store.deleteTimeReport(m)
};

function mount(device: FakeDevice): void {
	resetFakeFs();
	for (const [name, content] of device.files) files.set(name, content);
	resetOutboxForTests();
}

/** Etwas tun, BEVOR ein Konto verknuepft ist - also ohne Schreib-Haken. */
export async function withoutAccount(device: FakeDevice, fn: () => Promise<void>): Promise<void> {
	mount(device);
	await fn();
	device.files = new Map(files);
}

/** Etwas auf einem Geraet tun, mit laufender Engine. */
export async function onDevice<T>(
	ctx: DeviceContext,
	device: FakeDevice,
	fn: (engine: SyncEngine) => Promise<T>
): Promise<T> {
	mount(device);
	await startTracking(device.id);

	const engine = new SyncEngine({
		api: new Api({ baseUrl: "http://test", token: "t", fetchFn: ctx.server.fetchFor(device.id) }),
		key: ctx.key,
		store: localStore,
		deviceId: device.id,
		state: device.state,
		saveState: async (s) => {
			device.state = s;
		},
		onProgress: ctx.onProgress
	});
	engine.setMonthLister(() => store.listEntryMonths());

	try {
		return await fn(engine);
	} finally {
		device.files = new Map(files);
	}
}
