<script lang="ts">
	// Rückfrage vor einem Schritt, der sich nicht mit einem Klick zurückholen
	// lässt. Solange der Schritt läuft, bleibt der Dialog offen und gesperrt:
	// ein zweiter Klick liefe sonst doppelt, ein Wegklicken ließe das Ergebnis
	// ohne Fenster.
	import type { Snippet } from "svelte";
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button, type ButtonVariant } from "$lib/components/ui/button";

	interface Props {
		open: boolean;
		title: string | Snippet;
		description?: string | Snippet;
		confirmLabel: string;
		/** Beschriftung, solange `onConfirm` läuft. */
		busyLabel?: string;
		cancelLabel?: string;
		variant?: ButtonVariant;
		/** Bestätigen gesperrt, etwa solange noch keine Auswahl getroffen ist. */
		confirmDisabled?: boolean;
		/** Schließt nicht von selbst - das entscheidet `onClose` bzw. der Aufrufer. */
		onConfirm: () => Promise<unknown>;
		onClose: () => void;
		/** Weiterer Inhalt unter der Beschreibung (Auswahl, Hinweise). */
		children?: Snippet;
		class?: string;
	}

	let {
		open,
		title,
		description,
		confirmLabel,
		busyLabel,
		cancelLabel = "Abbrechen",
		variant = "destructive",
		confirmDisabled = false,
		onConfirm,
		onClose,
		children,
		class: className
	}: Props = $props();

	let busy = $state(false);

	async function confirm() {
		if (busy) return;
		busy = true;
		try {
			await onConfirm();
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root
	{open}
	onOpenChange={(o) => {
		if (!o && !busy) onClose();
	}}
>
	<Dialog.Content
		class={className}
		interactOutsideBehavior={busy ? "ignore" : "close"}
		escapeKeydownBehavior={busy ? "ignore" : "close"}
		showCloseButton={!busy}
	>
		<Dialog.Header>
			<Dialog.Title class={typeof title === "string" ? undefined : "flex items-center gap-2"}>
				{#if typeof title === "string"}{title}{:else}{@render title()}{/if}
			</Dialog.Title>
			{#if description}
				<Dialog.Description>
					{#if typeof description === "string"}{description}{:else}{@render description()}{/if}
				</Dialog.Description>
			{/if}
		</Dialog.Header>
		{@render children?.()}
		<Dialog.Footer>
			<Button variant="outline" disabled={busy} onclick={onClose}>{cancelLabel}</Button>
			<Button {variant} disabled={busy || confirmDisabled} onclick={confirm}>
				{busy && busyLabel ? busyLabel : confirmLabel}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
