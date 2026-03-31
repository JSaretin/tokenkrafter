<script lang="ts">
	import { locale, locales, type Locale } from '$lib/i18n';

	let open = $state(false);

	const currentLocale = $derived(locales.find((l) => l.code === $locale) ?? locales[0]);

	function select(code: Locale) {
		$locale = code;
		open = false;
	}

	function handleClickOutside(e: MouseEvent) {
		const target = e.target as HTMLElement;
		if (!target.closest('.lang-switcher')) {
			open = false;
		}
	}
</script>

<svelte:window onclick={handleClickOutside} />

<div class="lang-switcher relative">
	<button
		onclick={() => (open = !open)}
		class="lang-btn flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-mono cursor-pointer transition"
		title="Language"
	>
		<span class="font-bold">{currentLocale.flag}</span>
		<svg
			width="10"
			height="10"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			class="transition-transform {open ? 'rotate-180' : ''}"
		>
			<polyline points="6 9 12 15 18 9" />
		</svg>
	</button>

	{#if open}
		<div class="lang-dropdown absolute right-0 top-full mt-1 rounded-lg border backdrop-blur-xl overflow-hidden z-[60]">
			{#each locales as loc}
				<button
					onclick={() => select(loc.code)}
					class="lang-option flex items-center gap-2 w-full px-3 py-2 text-xs font-mono text-left cursor-pointer transition
					{loc.code === $locale ? 'active' : ''}"
				>
					<span class="font-bold w-5">{loc.flag}</span>
					<span>{loc.label}</span>
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.lang-btn {
		border-color: var(--border);
		background: var(--bg-surface);
		color: var(--text-muted);
	}
	.lang-btn:hover {
		border-color: rgba(0, 210, 255, 0.3);
		color: #00d2ff;
		background: rgba(0, 210, 255, 0.05);
	}
	.lang-dropdown {
		border-color: var(--border);
		background: var(--bg-nav);
		min-width: 140px;
	}
	.lang-option {
		color: var(--text-muted);
		background: transparent;
		border: none;
	}
	.lang-option:hover {
		background: rgba(0, 210, 255, 0.08);
		color: #00d2ff;
	}
	.lang-option.active {
		color: #00d2ff;
		background: rgba(0, 210, 255, 0.1);
	}
</style>
