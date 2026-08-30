<script lang="ts">
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
