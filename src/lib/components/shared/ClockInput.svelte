<script lang="ts">
	// Uhrzeit-Feld mit freier Eingabe ("1800", "8", "18.30"). `text` ist die
	// Roh-Eingabe, `value` die normalisierte Uhrzeit "HH:MM" – übernommen wird
	// erst beim Verlassen, damit das Tippen nicht springt.
	import { Input } from "$lib/components/ui/input";
	import { parseClock } from "$lib/time/time";

	let {
		id,
		value = $bindable(""),
		text = $bindable(""),
		placeholder,
		allowEmpty = false,
		oncommit
	}: {
		id: string;
		value?: string;
		text?: string;
		placeholder?: string;
		/** Leere Eingabe ist erlaubt und setzt `value` auf "". */
		allowEmpty?: boolean;
		/** Nach einer übernommenen Uhrzeit. */
		oncommit?: () => void;
	} = $props();

	/**
	 * Roh-Eingabe übernehmen; Unlesbares fällt auf die bisherige Uhrzeit zurück.
	 * Auch von aussen aufrufbar (`bind:this`): ein Absenden per Enter kommt vor
	 * dem Verlassen des Felds.
	 */
	export function commit() {
		const t = text.trim();
		if (allowEmpty && t === "") {
			value = text = "";
			oncommit?.();
			return;
		}
		const p = parseClock(t);
		if (p) value = p;
		text = value;
		if (p) oncommit?.();
	}
</script>

<Input
	{id}
	type="text"
	inputmode="numeric"
	{placeholder}
	value={text}
	oninput={(e) => (text = e.currentTarget.value)}
	onchange={commit}
/>
