// Die Kontozeitzone fuer die gesamte Testsuite festnageln - `TZ` stellt daneben die
// Geraetezone, damit die Suite in jeder Zone dasselbe liefert (siehe vitest.config.ts).
import { setAppTimeZone } from "../tz";

setAppTimeZone(process.env.APP_TZ ?? "Europe/Berlin");
