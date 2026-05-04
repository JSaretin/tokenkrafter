<script lang="ts">
	import { resolveTokenLogo, getCachedLogo } from '$lib/tokenLogo';

	let {
		logo,
		symbol = '?',
		size = 36,
		variant = 'brand',
		// When logo is empty, the component falls back to GeckoTerminal
		// via tokenLogo.resolveTokenLogo using this address+chain pair.
		// Same path the activity bot uses to enrich token cards. Skip
		// when address is omitted (e.g. native coin with logo always set).
		address = '',
		chainId = 56,
	}: {
		logo?: string;
		symbol?: string;
		size?: number;
		variant?: 'brand' | 'custom';
		address?: string;
		chainId?: number;
	} = $props();

	// Initialize from the in-memory cache so re-renders / scroll-back
	// don't re-trigger the GeckoTerminal call. resolveTokenLogo populates
	// this cache on first resolution per address:chainId.
	let resolvedLogo = $state(getCachedLogo(address, chainId) ?? '');

	$effect(() => {
		if (logo || !address) return;
		const cached = getCachedLogo(address, chainId);
		if (cached !== undefined) {
			resolvedLogo = cached;
			return;
		}
		let cancelled = false;
		resolveTokenLogo(address, chainId).then((url) => {
			if (!cancelled) resolvedLogo = url;
		});
		return () => { cancelled = true; };
	});

	let displayLogo = $derived(logo || resolvedLogo);

	let fallbackClass = $derived(
		variant === 'custom'
			? 'bg-[rgba(139,92,246,0.1)] text-[#a78bfa] border border-[rgba(139,92,246,0.2)]'
			: 'bg-[rgba(0,210,255,0.08)] text-[#00d2ff] border border-[rgba(0,210,255,0.15)]'
	);
</script>

{#if displayLogo}
	<img src={displayLogo} alt="" class="rounded-full object-cover shrink-0" style="width: {size}px; height: {size}px;" />
{:else}
	<div
		class={"flex items-center justify-center rounded-full shrink-0 font-display text-sm font-bold " + fallbackClass}
		style="width: {size}px; height: {size}px;"
	>
		{symbol.charAt(0)}
	</div>
{/if}
