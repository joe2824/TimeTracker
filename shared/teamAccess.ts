// Die Absage an ein Team-Mitglied, dessen Token der Server nicht (mehr) kennt.

/**
 * Wortgleich auf beiden Seiten: auf diese Absage hin baut das Gerät seine
 * Mitgliedschaft ab, und das lässt sich nicht zurücknehmen. Ein blosser
 * Status 401 genügt dafür nicht - den schickt auch ein Proxy oder eine
 * Wartungsseite vor dem Server.
 */
export const TEAM_ACCESS_DENIED = "Kein Team-Zugang";
