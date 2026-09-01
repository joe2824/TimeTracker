<script lang="ts">
	import { cn } from "$lib/utils";
	import { capabilities, isTauri } from "$lib/platform/env";
	import { account } from "$lib/sync/account.svelte";
	import TimerIcon from "@lucide/svelte/icons/timer";
	import FileTextIcon from "@lucide/svelte/icons/file-text";
	import BellIcon from "@lucide/svelte/icons/bell";
	import UserRoundIcon from "@lucide/svelte/icons/user-round";
	import ShieldCheckIcon from "@lucide/svelte/icons/shield-check";
	import MonitorCogIcon from "@lucide/svelte/icons/monitor-cog";
	import InfoIcon from "@lucide/svelte/icons/info";
	import MenuIcon from "@lucide/svelte/icons/menu";
	import XIcon from "@lucide/svelte/icons/x";
	import CheckIcon from "@lucide/svelte/icons/check";

	import TrackingTab from "./settings/TrackingTab.svelte";
	import ReportTab from "./settings/ReportTab.svelte";
	import RemindersTab from "./settings/RemindersTab.svelte";
	import AccountTab from "./settings/AccountTab.svelte";
	import AdminTab from "./settings/AdminTab.svelte";
	import SystemTab from "./settings/SystemTab.svelte";
	import AboutTab from "./settings/AboutTab.svelte";

	interface Props {
		/** Ob der Einstellungs-Tab gerade sichtbar ist. */
		active?: boolean;
	}
	let { active = false }: Props = $props();

	/**
	 * Einmal geoeffnet, bleibt aufgebaut.
	 *
	 * bits-ui baut alle Tab-Inhalte mit auf. Ohne diese Sperre fragten die
	 * Unterbereiche schon beim Programmstart Konto, Passkeys, Einladungen und
	 * Sicherungen ab - vier Anfragen fuer eine Ansicht, die vielleicht niemand
	 * oeffnet. Beim Zeigen auf den Tab laedt `prefetchAccount` vor.
	 */
	let opened = $state(false);
	$effect(() => {
		if (active) opened = true;
	});

	type SettingsTabId =
		| "erfassung"
		| "bericht"
		| "erinnerungen"
		| "konto"
		| "verwaltung"
		| "system"
		| "ueber";

	interface SettingsTabInfo {
		id: SettingsTabId;
		title: string;
		icon: typeof TimerIcon;
		description: string;
	}

	const tabs = $derived.by(() => {
		const list: SettingsTabInfo[] = [
			{
				id: "erfassung",
				title: "Zeiterfassung",
				icon: TimerIcon,
				description: "Wie der Timer sich verhält und woraus sich ein Arbeitstag rechnet."
			},
			{
				id: "bericht",
				title: "Bericht",
				icon: FileTextIcon,
				description: "Empfänger, Betreff und was außer den Zeiten noch angezeigt wird."
			},
			{
				id: "erinnerungen",
				title: "Erinnerungen",
				icon: BellIcon,
				description: "Wann die App sich von selbst meldet."
			},
			{
				id: "konto",
				title: "Konto",
				icon: UserRoundIcon,
				description: "Anmeldung, Geräte und der Abgleich zwischen ihnen."
			}
		];
		if (account.isAdmin) {
			list.push({
				id: "verwaltung",
				title: "Verwaltung",
				icon: ShieldCheckIcon,
				description: "Server-Backups, Einladungen und Registrierungsrichtlinien."
			});
		}
		if (capabilities.autostart || capabilities.updater || isTauri()) {
			list.push({
				id: "system",
				title: "System",
				icon: MonitorCogIcon,
				description: "Start mit Windows, Updates und die Daten auf diesem Gerät."
			});
		}
		list.push({
			id: "ueber",
			title: "Über",
			icon: InfoIcon,
			description: "Version, Datenschutz und Protokoll."
		});
		return list;
	});

	let activeTabId = $state<SettingsTabId>("erfassung");
	let isMobileMenuOpen = $state(false);
	const activeTab = $derived(tabs.find((t) => t.id === activeTabId) ?? tabs[0]);
	const ActiveIcon = $derived(activeTab.icon);

	function selectTab(id: SettingsTabId) {
		activeTabId = id;
		isMobileMenuOpen = false;
	}
</script>

{#if opened}

<div class="flex flex-col gap-5 lg:flex-row lg:items-start lg:gap-8">
	<!-- Mobile Burger Navigation Bar (nur auf mobilen Bildschirmen) -->
	<div class="block lg:hidden">
		<button
			type="button"
			onclick={() => (isMobileMenuOpen = !isMobileMenuOpen)}
			aria-expanded={isMobileMenuOpen}
			aria-label="Einstellungsbereich auswählen"
			class="w-full flex items-center justify-between gap-3 rounded-xl border bg-card p-3 shadow-xs transition-colors hover:bg-accent/40 text-left"
		>
			<div class="flex items-center gap-3 min-w-0">
				<div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
					<ActiveIcon class="size-4.5" />
				</div>
				<div class="min-w-0">
					<p class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Einstellungen</p>
					<p class="font-medium text-sm text-foreground truncate">{activeTab.title}</p>
				</div>
			</div>
			<div class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
				{#if isMobileMenuOpen}
					<XIcon class="size-4" />
				{:else}
					<MenuIcon class="size-4" />
				{/if}
			</div>
		</button>

		<!-- Mobile Dropdown Menü -->
		{#if isMobileMenuOpen}
			<div class="mt-2 rounded-xl border bg-card p-1.5 shadow-lg divide-y divide-border/50 animate-in fade-in-0 zoom-in-95 duration-150">
				{#each tabs as tab (tab.id)}
					{@const Icon = tab.icon}
					{@const isActive = activeTabId === tab.id}
					<button
						type="button"
						onclick={() => selectTab(tab.id)}
						class={cn(
							"w-full flex items-center justify-between gap-3 rounded-lg p-2.5 text-left transition-colors",
							isActive ? "bg-primary/10 text-primary font-medium" : "text-foreground hover:bg-muted/60"
						)}
					>
						<div class="flex items-center gap-3 min-w-0">
							<Icon class="size-4.5 shrink-0 {isActive ? 'text-primary' : 'text-muted-foreground'}" />
							<div class="min-w-0">
								<p class="text-sm leading-snug">{tab.title}</p>
								<p class="text-xs text-muted-foreground line-clamp-1">{tab.description}</p>
							</div>
						</div>
						{#if isActive}
							<CheckIcon class="size-4 shrink-0 text-primary" />
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Desktop Sidebar Navigation (ab lg: Breakpoint) -->
	<nav
		aria-label="Einstellungsbereiche"
		class="hidden lg:flex lg:sticky lg:top-24 lg:w-56 lg:flex-col lg:overflow-visible lg:bg-transparent lg:p-0 gap-1 shrink-0"
	>
		{#each tabs as tab (tab.id)}
			{@const Icon = tab.icon}
			<button
				type="button"
				onclick={() => selectTab(tab.id)}
				aria-current={activeTabId === tab.id ? "page" : undefined}
				class={cn(
					"text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-3 w-full justify-start",
					activeTabId === tab.id
						? "bg-muted text-foreground font-semibold"
						: "hover:bg-muted/60"
				)}
			>
				<Icon class="size-4 shrink-0" />
				{tab.title}
			</button>
		{/each}
	</nav>

	<!-- Content Area -->
	<div class="min-w-0 flex-1 space-y-4 lg:max-w-3xl">
		<div class="space-y-0.5">
			<h2 class="text-lg leading-tight font-semibold tracking-tight">{activeTab.title}</h2>
			<p class="text-muted-foreground text-sm">{activeTab.description}</p>
		</div>

		{#if activeTabId === "erfassung"}
			<TrackingTab />
		{:else if activeTabId === "bericht"}
			<ReportTab />
		{:else if activeTabId === "erinnerungen"}
			<RemindersTab />
		{:else if activeTabId === "konto"}
			<AccountTab />
		{:else if activeTabId === "verwaltung"}
			<AdminTab />
		{:else if activeTabId === "system"}
			<SystemTab />
		{:else if activeTabId === "ueber"}
			<AboutTab />
		{/if}
	</div>
</div>
{/if}
