// Ob der Willkommensbildschirm noch etwas zu zeigen hat.
//
// Nach dem Anlegen ist das Konto verknüpft - die Anmeldeseite wäre damit weg.
// Es fehlt aber noch eine Frage: gibt es die Anwendung schon auf dem Rechner?
// Solange die offen ist, bleibt der Bildschirm stehen.

/** Die Schritte des Web-Onboardings. Muss zu `WebOnboarding.svelte` passen. */
export type OnboardingStep = "start" | "phrase" | "unlock" | "device";

/**
 * `step` setzt den Einstieg. Leer heißt "von vorn" - so kommt jemand ohne Konto
 * an, und so war es vor dem Feld auch. Gefüllt springt der Dev-Knopf mitten
 * hinein, ohne den ganzen Weg noch einmal zu gehen.
 */
export const onboardingOpen = $state<{ value: boolean; step: OnboardingStep | "" }>({
	value: false,
	step: ""
});
