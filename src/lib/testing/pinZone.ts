// Die Kontozeitzone fuer die gesamte Testsuite festnageln.
//
// Der Sinn steht in vitest.config.ts: die Suite muss dasselbe Ergebnis liefern,
// egal in welcher Zone das GERAET steht. Deshalb setzt dieses Setup die
// Kontozeitzone hart auf Berlin, waehrend `TZ` die Geraetezone stellt. Laeuft die
// Suite unter `TZ=Pacific/Auckland` gruen, ist bewiesen, dass keine Rechnung
// mehr an der Geraetezeit haengt.
import { setAppTimeZone } from "../tz";

setAppTimeZone(process.env.APP_TZ ?? "Europe/Berlin");
