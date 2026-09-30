import { toast } from "svelte-sonner";

/**
 * Text in die Zwischenablage legen. Scheitert das (fehlende Berechtigung,
 * Fenster ohne Fokus), meldet ein Toast den Ausweg von Hand.
 */
export async function copyText(text: string, success?: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		if (success) toast.success(success);
		return true;
	} catch {
		toast.error("Kopieren nicht möglich – bitte von Hand kopieren.");
		return false;
	}
}
