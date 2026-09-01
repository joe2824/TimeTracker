// Anonyme Nutzungszaehlung fuer den eigenen TimeTracker-Server.
// Erfasst ausschliesslich: taegliche Aktivitaet, App-Version und Betriebssystem/Plattform.
// Keine personenbezogenen Daten, keine Zeiteintraege, keine Fehler-Uploads an Fremdanbieter.
//
// Gesendet wird in `account.sendUsagePing()` - der Weg dorthin ist derselbe wie
// bei jedem anderen Serveraufruf und weist sich damit auch genauso aus.

/**
 * Ermittelt das Betriebssystem bzw. die Plattform fuer die Statistik.
 */
export function detectPlatform(): string {
  if (typeof window === "undefined") return "unknown";
  const inTauri = "__TAURI_INTERNALS__" in window;
  const ua = (navigator.userAgent || "").toLowerCase();
  const plat = ((navigator as any).platform || "").toLowerCase();

  if (inTauri) {
    if (ua.includes("mac") || plat.includes("mac")) return "macos";
    if (ua.includes("win") || plat.includes("win")) return "windows";
    if (ua.includes("linux") || plat.includes("linux")) return "linux";
    return "desktop";
  }

  if (ua.includes("mac") || plat.includes("mac")) return "web-mac";
  if (ua.includes("win") || plat.includes("win")) return "web-win";
  if (ua.includes("linux") || plat.includes("linux")) return "web-linux";
  return "web";
}

/**
 * Wie eine Tagesmeldung ausgegangen ist.
 *
 * - `sent`: angekommen, der Tag ist erledigt.
 * - `retry`: gerade nicht - kein Netz, Bremse, abgemeldet, Serverfehler.
 * - `declined`: dieser Server will keine Meldung. Nicht wiederholen.
 */
export type PingResult = "sent" | "retry" | "declined";

/**
 * Antwortstatus, nach denen ein zweiter Versuch nichts anderes ergaebe: den
 * Endpunkt gibt es nicht (404/405/410) oder die Herkunft ist abgelehnt (403).
 *
 * 401 gehoert NICHT dazu - das heisst auch "gerade abgemeldet", und wer sich
 * wieder anmeldet, soll wieder zaehlen. Gegen endloses Klopfen steht stattdessen
 * die Versuchsgrenze in `watchers.svelte.ts`.
 */
const DECLINED_STATUS = new Set([403, 404, 405, 410]);

/** Was ein fehlgeschlagener Versuch bedeutet. Status 0 heisst "kein Netz". */
export function classifyPingFailure(status: number): PingResult {
  return DECLINED_STATUS.has(status) ? "declined" : "retry";
}
