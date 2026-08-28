// Was beim Bauen festgelegt wird.

/** Setzt vite.config.js ein. Im Test steht er nicht - daher die Pruefung unten. */
declare const __DEFAULT_SERVER__: string;

/**
 * Der Server, der ohne Zutun eingetragen ist.
 *
 * Kommt aus `DEFAULT_SERVER` und wird beim Bauen eingesetzt - in der
 * GitHub-Action aus einer Repository-Variable, lokal aus der Umgebung. Leer
 * heisst: es gibt keinen, dann fragt die Oberflaeche wie bisher danach.
 *
 * Bewusst kein fester Wert im Quelltext: wer die Anwendung selbst baut, soll
 * seinen eigenen Server eintragen koennen, ohne eine Zeile zu aendern.
 */
export const DEFAULT_SERVER =
	typeof __DEFAULT_SERVER__ === "string" ? __DEFAULT_SERVER__.trim().replace(/\/+$/, "") : "";
