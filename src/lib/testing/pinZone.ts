// Die Kontozeitzone für die gesamte Testsuite festnageln - `TZ` stellt daneben die
// Gerätezone, damit die Suite in jeder Zone dasselbe liefert (siehe vitest.config.ts).
import { setAppTimeZone } from "../time/tz";

setAppTimeZone(process.env.APP_TZ ?? "Europe/Berlin");
