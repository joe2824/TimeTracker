<script lang="ts">
	import { onMount } from "svelte";
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

	import TrackingTab from "./settings/TrackingTab.svelte";
	import ReportTab from "./settings/ReportTab.svelte";
	import RemindersTab from "./settings/RemindersTab.svelte";
	import AccountTab from "./settings/AccountTab.svelte";
	import AdminTab from "./settings/AdminTab.svelte";
	import SystemTab from "./settings/SystemTab.svelte";
	import AboutTab from "./settings/AboutTab.svelte";

	onMount(() => {
		void account.accountInfo().catch(() => {});
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
	const activeTab = $derived(tabs.find((t) => t.id === activeTabId) ?? tabs[0]);
</script>

<div class="flex flex-col gap-5 lg:flex-row lg:items-start lg:gap-8">
	<!-- Navigation -->
	<nav
		aria-label="Einstellungsbereiche"
		class="scrollbar-lose bg-muted/50 flex shrink-0 gap-1 overflow-x-auto rounded-xl p-1 lg:sticky lg:top-24 lg:w-56 lg:flex-col lg:overflow-visible lg:bg-transparent lg:p-0"
	>
		{#each tabs as tab (tab.id)}
			{@const Icon = tab.icon}
			<button
				type="button"
				onclick={() => (activeTabId = tab.id)}
				aria-current={activeTabId === tab.id ? "page" : undefined}
				class={cn(
					"text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-3 lg:w-full lg:justify-start",
					activeTabId === tab.id
						? "bg-background text-foreground ring-foreground/10 ring-1 lg:bg-muted lg:ring-0"
						: "hover:bg-background/60 lg:hover:bg-muted/60"
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
