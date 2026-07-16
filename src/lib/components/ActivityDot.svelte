<script lang="ts">
	// Farbpunkt einer Aktivitaet. Vorher an vier Stellen zeichengleich kopiert
	// (TrackingPanel 2x, CommandPalette, Tray-Flyout), jeweils mit eigener
	// {#if color}-Wache drumherum – die steckt jetzt hier drin.
	interface Props {
		/** Hex-Farbe der Aktivitaet; ohne Farbe wird nichts gerendert */
		color?: string;
	}
	let { color }: Props = $props();
</script>

{#if color}
	<span class="size-2.5 shrink-0 rounded-full" style="background:{color}"></span>
{/if}
