<script lang="ts">
	import { locale, locales, type Locale } from '$lib/i18n';

	let { direction = 'down' }: { direction?: 'up' | 'down' } = $props();

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
		class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-line bg-surface text-muted hover:border-[rgba(0,210,255,0.3)] hover:text-[#00d2ff] hover:bg-[rgba(0,210,255,0.05)] text-xs font-mono cursor-pointer transition"
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
			class={'transition-transform ' + ((open !== (direction === 'up')) ? 'rotate-180' : '')}
		>
			<polyline points="6 9 12 15 18 9" />
		</svg>
	</button>

	{#if open}
		<div class={'absolute right-0 rounded-lg border border-line bg-nav min-w-[140px] backdrop-blur-xl overflow-hidden z-[60] ' + (direction === 'up' ? 'bottom-full mb-1' : 'top-full mt-1')}>
			{#each locales as loc}
				<button
					onclick={() => select(loc.code)}
					class={'flex items-center gap-2 w-full px-3 py-2 text-xs font-mono text-left cursor-pointer transition bg-transparent border-none hover:bg-[rgba(0,210,255,0.08)] hover:text-[#00d2ff] ' + (loc.code === $locale ? 'text-[#00d2ff] bg-[rgba(0,210,255,0.1)]' : 'text-muted')}
				>
					<span class="font-bold w-5">{loc.flag}</span>
					<span>{loc.label}</span>
				</button>
			{/each}
		</div>
	{/if}
</div>
