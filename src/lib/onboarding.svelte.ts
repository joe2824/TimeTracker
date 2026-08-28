// Ob der Willkommensbildschirm noch etwas zu zeigen hat.
//
// Nach dem Anlegen ist das Konto verknuepft - die Anmeldeseite waere damit weg.
// Es fehlt aber noch eine Frage: gibt es die Anwendung schon auf dem Rechner?
// Solange die offen ist, bleibt der Bildschirm stehen.
export const onboardingOffen = $state({ wert: false });
