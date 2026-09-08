// Was beim Bauen festgelegt wird.

/** Setzt vite.config.js ein. Im Test steht er nicht - daher die Prüfung unten. */
declare const __DEFAULT_SERVER__: string;
declare const __APP_VERSION__: string;
declare const __TELEMETRY_KEY__: string;

/**
 * Die Anwendungsversion aus package.json.
 */
export const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.9.0-beta.7";

/**
 * Der Server, der ohne Zutun eingetragen ist.
 *
 * Kommt aus `DEFAULT_SERVER` und wird beim Bauen eingesetzt - in der
 * GitHub-Action aus einer Repository-Variable, lokal aus der Umgebung. Leer
 * heisst: es gibt keinen, dann fragt die Oberfläche wie bisher danach.
 *
 * Bewusst kein fester Wert im Quelltext: wer die Anwendung selbst baut, soll
 * seinen eigenen Server eintragen können, ohne eine Zeile zu ändern.
 */
export const DEFAULT_SERVER =
	typeof __DEFAULT_SERVER__ === "string" ? __DEFAULT_SERVER__.trim().replace(/\/+$/, "") : "";

/**
 * Der Schlüssel, mit dem sich die Tagesmeldung beim Server ausweist.
 *
 * Kommt aus `TELEMETRY_KEY` und wird beim Bauen eingesetzt. Leer heisst nicht
 * "meldet nichts": mit verknüpftem Konto läuft die Meldung über denselben Weg
 * wie jeder andere Serveraufruf und weist sich mit Gerätetoken bzw. Sitzung aus
 * - so kommt die PWA durch, die im Server-Image liegt und gar keinen
 * Schlüssel mitbekommen kann.
 *
 * OHNE Konto ist der Schlüssel der einzige Ausweis. Er entscheidet damit, ob
 * eine Desktop-Installation gezählt wird, die noch kein Konto verknüpft hat.
 *
 * Er steckt zwangsläufig im ausgelieferten Bundle und ist damit kein
 * Geheimnis - er hält Spam von aussen ab, nicht jemanden, der sich ein Release
 * ansieht.
 */
export const TELEMETRY_KEY =
	typeof __TELEMETRY_KEY__ === "string" ? __TELEMETRY_KEY__.trim() : "";
