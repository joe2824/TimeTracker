<script lang="ts">
	interface Props {
		/** Hex-Farbe der Aktivität; ohne Farbe wird nichts gerendert */
		color?: string;
	}
	let { color }: Props = $props();
</script>

{#if color}
	<span class="size-2.5 shrink-0 rounded-full" style="background:{color}"></span>
{/if}
