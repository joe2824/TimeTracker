<script lang="ts">
	// Lucide fuehrt keine Markenzeichen mehr, das Oktokatzen-Zeichen faellt also
	// nicht mit den uebrigen Symbolen ab - es muss von Hand daneben stehen.
	// Sonst verhaelt es sich wie ein Lucide-Symbol: Groesse und Farbe kommen
	// vom Elternteil.
	import type { SVGAttributes } from "svelte/elements";

	let { class: className = "size-4", ...restProps }: SVGAttributes<SVGElement> = $props();
</script>

<svg
	viewBox="0 0 24 24"
	fill="currentColor"
	aria-hidden="true"
	class={className}
	{...restProps}
>
	<path
		d="M12 .5C5.73.5.66 5.57.66 11.84c0 5.01 3.25 9.26 7.76 10.76.57.1.78-.25.78-.55v-1.94c-3.16.69-3.83-1.52-3.83-1.52-.52-1.31-1.26-1.66-1.26-1.66-1.03-.71.08-.69.08-.69 1.14.08 1.74 1.17 1.74 1.17 1.01 1.74 2.66 1.24 3.31.95.1-.73.4-1.24.72-1.52-2.52-.29-5.17-1.26-5.17-5.62 0-1.24.44-2.26 1.17-3.06-.12-.28-.51-1.44.11-3 0 0 .95-.31 3.12 1.17a10.8 10.8 0 0 1 2.84-.38c.96 0 1.93.13 2.84.38 2.17-1.48 3.12-1.17 3.12-1.17.62 1.56.23 2.72.11 3 .73.8 1.17 1.82 1.17 3.06 0 4.37-2.66 5.33-5.19 5.61.41.35.78 1.05.78 2.12v3.14c0 .3.2.66.79.55a11.36 11.36 0 0 0 7.75-10.76C23.34 5.57 18.27.5 12 .5Z"
	/>
</svg>
