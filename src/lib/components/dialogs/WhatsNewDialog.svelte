<script lang="ts">
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import { CURRENT_RELEASE, whatsNew } from "$lib/release/whatsNew.svelte";
	import CloudIcon from "@lucide/svelte/icons/cloud";
	import ShieldCheckIcon from "@lucide/svelte/icons/shield-check";
	import KeyRoundIcon from "@lucide/svelte/icons/key-round";
	import DatabaseIcon from "@lucide/svelte/icons/database";
	import SparklesIcon from "@lucide/svelte/icons/sparkles";

	const iconMap = {
		cloud: CloudIcon,
		shield: ShieldCheckIcon,
		key: KeyRoundIcon,
		database: DatabaseIcon,
		sparkles: SparklesIcon
	};
</script>

<Dialog.Root
	open={whatsNew.isOpen}
	onOpenChange={(v) => {
		whatsNew.isOpen = v;
		if (!v) whatsNew.markAsSeen();
	}}
>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header class="space-y-2">
			<div class="flex items-center gap-2">
				<Badge variant="secondary" class="gap-1.5 px-2.5 py-0.5 text-xs font-semibold text-primary bg-primary/10">
					<SparklesIcon class="size-3.5" />
					Version {CURRENT_RELEASE.version}
				</Badge>
			</div>
			<Dialog.Title class="text-xl font-bold tracking-tight">
				{CURRENT_RELEASE.title}
			</Dialog.Title>
			<Dialog.Description class="text-xs text-muted-foreground leading-relaxed">
				{CURRENT_RELEASE.summary}
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-2.5 py-2">
			{#each CURRENT_RELEASE.highlights as h (h.title)}
				{@const Icon = iconMap[h.icon] ?? SparklesIcon}
				<div class="flex items-start gap-3 rounded-lg border bg-muted/20 p-3 transition-colors hover:bg-muted/40">
					<div class="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary mt-0.5">
						<Icon class="size-4" />
					</div>
					<div class="space-y-0.5 min-w-0 flex-1">
						<p class="text-sm font-semibold text-foreground leading-snug">{h.title}</p>
						<p class="text-xs text-muted-foreground leading-relaxed">{h.description}</p>
					</div>
				</div>
			{/each}
		</div>

		<Dialog.Footer class="pt-2">
			<Button class="w-full sm:w-auto" onclick={() => whatsNew.markAsSeen()}>
				Verstanden
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

