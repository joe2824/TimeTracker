// Die Kontozeitzone für die gesamte Testsuite festnageln - `TZ` stellt daneben die
// Gerätezone, damit die Suite in jeder Zone dasselbe liefert (siehe vitest.config.ts).
import { vi } from "vitest";
import { setAppTimeZone } from "../time/tz";

const PINNED_ZONE = process.env.APP_TZ ?? "Europe/Berlin";

// Ohne gespeicherte Zone übernimmt die App beim Laden die des Geräts. Ein Test mit
// frischen Einstellungen (etwa nach dem Verknüpfen) wechselte sonst mitten im
// Lauf von der festgenagelten Zone auf `TZ` - und Monatsschlüssel von davor und
// danach passten an einem Monatswechsel nicht mehr zusammen.
vi.mock("../time/tz", async (importOriginal) => ({
	...(await importOriginal<typeof import("../time/tz")>()),
	systemTimeZone: () => PINNED_ZONE
}));

setAppTimeZone(PINNED_ZONE);
