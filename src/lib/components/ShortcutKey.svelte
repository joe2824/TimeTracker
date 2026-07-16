<script lang="ts">
	// Ein belegtes Tastenkuerzel als Keycap, klickbar zum Neubelegen.
	// Vorher zweimal von Hand gebaut (SettingsPanel, ActivitiesPanel) – mit
	// auseinandergelaufenen Abstaenden und nur einmal mit Zeiger-Cursor.
	//
	// Nur fuer ein VORHANDENES Kuerzel: die Keycap-Optik sagt "das ist eine Taste".
	// Fuers Festlegen gehoert ein normaler Button hin, keine Taste.
	import { Button } from "$lib/components/ui/button";

	interface Props {
		/** Accelerator, z.B. "Control+Alt+1" */
		shortcut: string;
		title?: string;
		onclick: () => void;
	}
	let { shortcut, title = "Shortcut ändern", onclick }: Props = $props();
</script>

<Button variant="outline" size="xs" class="bg-muted shrink-0 font-mono" {title} {onclick}>
	{shortcut}
</Button>
