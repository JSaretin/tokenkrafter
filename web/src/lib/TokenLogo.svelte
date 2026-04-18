<script lang="ts">
	import { getKnownLogo, getCachedLogo, resolveTokenLogo, setCachedLogo } from './tokenLogo';

	let {
		address = '',
		chainId = 56,
		symbol = '',
		geckoNetwork = 'bsc',
		size = 32,
		logoUrl = '',
	}: {
		address?: string;
		chainId?: number;
		symbol?: string;
		geckoNetwork?: string;
		size?: number;
		logoUrl?: string;
	} = $props();

	let resolved = $state('');
	let loading = $state(false);
	let errored = $state(false);

	// Resolve logo from multiple sources
	$effect(() => {
		errored = false;

		// 1. Explicit logoUrl prop (already known)
		if (logoUrl) {
			resolved = logoUrl;
			if (address) setCachedLogo(address, chainId, logoUrl);
			return;
		}

		// 2. Known logo by symbol (instant)
		const known = getKnownLogo(symbol);
		if (known) {
			resolved = known;
			return;
		}

		// 3. Check cache (instant)
		if (address) {
			const cached = getCachedLogo(address, chainId);
			if (cached !== undefined) {
				resolved = cached;
				return;
			}
		}

		// 4. Async resolve
		if (address) {
			resolved = '';
			loading = true;
			resolveTokenLogo(address, chainId, geckoNetwork).then((url) => {
				resolved = url;
				loading = false;
			}).catch(() => {
				resolved = '';
				loading = false;
			});
		} else {
			resolved = '';
		}
	});

	let fallbackLetter = $derived((symbol || '?').charAt(0).toUpperCase());
	let fallbackColor = $derived(stringToColor(symbol || address || ''));

	function stringToColor(str: string): string {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			hash = str.charCodeAt(i) + ((hash << 5) - hash);
		}
		const h = Math.abs(hash) % 360;
		return `hsl(${h}, 55%, 45%)`;
	}
</script>

{#if resolved && !errored}
	<img
		src={resolved}
		alt={symbol || 'Token'}
		width={size}
		height={size}
		class="rounded-full object-cover shrink-0"
		style="width: {size}px; height: {size}px;"
		onerror={() => { errored = true; }}
	/>
{:else if loading}
	<div class="tl-shimmer rounded-full shrink-0" style="width: {size}px; height: {size}px;"></div>
{:else}
	<div
		class="rounded-full flex items-center justify-center text-white font-display font-bold shrink-0 select-none"
		style="width: {size}px; height: {size}px; font-size: {Math.max(size * 0.42, 10)}px; background: {fallbackColor};"
	>{fallbackLetter}</div>
{/if}

<style>
	.tl-shimmer {
		background: linear-gradient(110deg, rgba(255,255,255,0.04) 30%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 70%);
		background-size: 200% 100%;
		animation: shimmer 1.2s ease-in-out infinite;
	}
	@keyframes shimmer {
		0% { background-position: 200% 0; }
		100% { background-position: -200% 0; }
	}
</style>
