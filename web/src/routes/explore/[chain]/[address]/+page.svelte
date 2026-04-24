<script lang="ts">
	import { ethers } from 'ethers';
	import { onMount, getContext } from 'svelte';
	import { t } from '$lib/i18n';
	import type { PageData } from './$types';
	import type { TaxDistributionRow, ExplorePool, Eip1193Provider, ImportedTokenRow } from '$lib/structure';
	import { toExploreView } from '$lib/structure/views/exploreView';
	import { PlatformTokenClient, type ProtectionSettings } from '$lib/contracts/platformToken';
	import TradeWarningBanner from './lib/TradeWarningBanner.svelte';
	import TokenHero from './lib/TokenHero.svelte';
	import FeatureBadges from './lib/FeatureBadges.svelte';
	import StatsStrip from './lib/StatsStrip.svelte';
	import TaxPanel from './lib/TaxPanel.svelte';
	import ProtectionPanel from './lib/ProtectionPanel.svelte';
	import TaxDistributionPanel from './lib/TaxDistributionPanel.svelte';
	import PoolsList from './lib/PoolsList.svelte';
	import ContractInfo from './lib/ContractInfo.svelte';

	let { data }: { data: PageData } = $props();

	const { tokenAddress, chain: chainInfo, dbData, lensData, launchData } = data;

	// ── SSR payload unpack ──
	const onChainData = lensData?.tokenInfo || null;
	const ssrPriceUsd: number = lensData?.onChainPriceUsd || 0;
	let pools = $state<ExplorePool[]>(lensData?.pools || []);
	const ssrTaxInfo = lensData?.taxInfo || null;
	let taxInfo = ssrTaxInfo;

	// ── Collapsed display shape ──
	let view = $derived(toExploreView(dbData, onChainData, pools, $t('explore.detail.unknownToken')));

	// ── User-specific derivations (depend on context, not SSR data) ──
	let getUserAddress: () => string | null = getContext('userAddress');
	let userAddress = $derived(getUserAddress());
	let isCreator = $derived(!!(userAddress && view.creator && userAddress.toLowerCase() === view.creator.toLowerCase()));

	// ── Read-only network providers (shared across app, no wallet needed) ──
	let getNetworkProviders: () => Map<number, ethers.JsonRpcProvider> = getContext('networkProviders');
	let getProvidersReady: () => boolean = getContext('providersReady');
	let networkProviders = $derived(getNetworkProviders());
	let providersReady = $derived(getProvidersReady());

	// ── Transient UI state ──
	let copied = $state(false);
	let copiedUrl = $state(false);
	let addedToWallet = $state(false);

	// ── Market data: on-chain price (SSR) + GeckoTerminal (volume/24h change) ──
	const GECKO_NETS: Record<number, string> = { 56: 'bsc', 1: 'eth', 8453: 'base', 42161: 'arbitrum', 137: 'polygon_pos' };
	let price = $state(ssrPriceUsd);
	let geckoPrice = $state(0);
	let volume24h = $state(0);
	let priceChange24h = $state(0);
	let geckoLoading = $state(true);

	let effectivePrice = $derived(price > 0 ? price : geckoPrice);
	let mcap = $derived(effectivePrice > 0 ? effectivePrice * parseFloat(ethers.formatUnits(view.totalSupply, view.decimals)) : 0);

	// ── Honeypot / not-trading banner logic ──
	let simFailed = $derived(!!(taxInfo && (!taxInfo.canBuy || !taxInfo.canSell)));
	let isHoneypot = $derived(simFailed && !view.isOnPlatform);
	let antiSnipeLock = $state(!!launchData?.antiSnipeSeconds);
	let antiSnipeSeconds = $state(launchData?.antiSnipeSeconds ?? 0);
	let notTradingYet = $derived(simFailed && view.isOnPlatform && (!view.hasLiquidity || antiSnipeLock));

	// ── Launch cross-link ──
	let launchAddress = $state<string | null>(launchData?.address ?? null);

	// ── On-chain protection settings + tax distribution (loaded in onMount) ──
	let protection = $state<ProtectionSettings>({ maxWallet: 0n, maxTransaction: 0n, cooldownTime: 0n, blacklistWindow: 0n });
	let taxDistribution = $state<TaxDistributionRow[]>([]);

	// ── Local formatters (tuned for this view's display rules) ──
	function fmtPrice(v: number): string {
		if (v === 0) return '—';
		if (v >= 1) return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
		const absVal = Math.abs(v);
		const magnitude = Math.floor(Math.log10(absVal));
		const decimals = Math.min(20, Math.max(2, 4 - magnitude - 1));
		return `$${v.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '')}`;
	}

	function fmtMcap(v: number): string {
		if (v <= 0) return '—';
		if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
		if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
		if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
		return `$${v.toFixed(0)}`;
	}

	function fmtVol(v: number): string {
		if (v <= 0) return '—';
		if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
		if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
		return `$${v.toFixed(0)}`;
	}

	function fmtSupply(val: string | number, dec: number): string {
		const raw = String(val ?? '0');
		const n = /^\d+$/.test(raw)
			? parseFloat(ethers.formatUnits(raw, dec))
			: parseFloat(raw);
		if (!Number.isFinite(n) || n === 0) return '0';
		if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
		if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
		if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
		if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
		return n.toLocaleString();
	}

	onMount(async () => {
		// Fetch GeckoTerminal price data
		const geckoNet = GECKO_NETS[chainInfo.id];
		if (geckoNet) {
			try {
				const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${geckoNet}/tokens/${tokenAddress}`);
				if (res.ok) {
					const json = await res.json();
					const a = json?.data?.attributes;
					if (a) {
						geckoPrice = parseFloat(a.price_usd || '0');
						volume24h = parseFloat(a.volume_usd?.h24 || '0');
						priceChange24h = parseFloat(a.price_change_percentage?.h24 || '0');
					}
				}
			} catch {}
		}
		geckoLoading = false;
	});

	// Fetch on-chain protection settings + tax distribution (platform tokens only).
	// Runs once providersReady flips true — uses the shared networkProviders map
	// rather than constructing a per-page JsonRpcProvider.
	let _onChainFetched = false;
	$effect(() => {
		if (!providersReady || _onChainFetched) return;
		if (!view.isOnPlatform) return;
		const prov = networkProviders.get(chainInfo.id);
		if (!prov) return;
		_onChainFetched = true;
		(async () => {
			try {
				const client = new PlatformTokenClient(tokenAddress, prov);
				const [prot, dist] = await Promise.all([
					client.getProtectionSettings(),
					client.getTaxDistribution(),
				]);
				protection = prot;
				taxDistribution = dist;
			} catch {}
		})();
	});

	function copyAddress() {
		navigator.clipboard.writeText(tokenAddress);
		copied = true;
		setTimeout(() => copied = false, 2000);
	}

	function shareUrl() {
		if (navigator.share) {
			navigator.share({ title: `${view.name} (${view.symbol})`, url: window.location.href });
		} else {
			navigator.clipboard.writeText(window.location.href);
			copiedUrl = true;
			setTimeout(() => copiedUrl = false, 2000);
		}
	}

	async function addToWallet() {
		try {
			const ethereum = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
			if (ethereum?.request) {
				await ethereum.request({
					method: 'wallet_watchAsset',
					params: { type: 'ERC20', options: { address: tokenAddress, symbol: view.symbol.slice(0, 11), decimals: view.decimals, image: view.logoUrl || undefined } },
				});
			}
		} catch {}
		try {
			const saved: ImportedTokenRow[] = JSON.parse(localStorage.getItem('imported_tokens') || '[]');
			if (!saved.some(t => t.address?.toLowerCase() === tokenAddress.toLowerCase())) {
				saved.push({ address: tokenAddress.toLowerCase(), name: view.name, symbol: view.symbol, decimals: view.decimals, logoUrl: view.logoUrl || '' });
				localStorage.setItem('imported_tokens', JSON.stringify(saved));
				import('$lib/embeddedWallet').then(m => m.pushPreferences()).catch(() => {});
			}
		} catch {}
		addedToWallet = true;
		setTimeout(() => addedToWallet = false, 3000);
	}
</script>

<svelte:head>
	<title>{$t('explore.detail.metaTitle').replace('{symbol}', view.symbol).replace('{name}', view.name)}</title>
	<meta name="description" content="{view.name} ({view.symbol}) on {chainInfo.name}. {view.description?.slice(0, 120) || $t('explore.detail.metaDescDefault')}" />
	{#if view.logoUrl}<meta property="og:image" content={view.logoUrl} />{/if}
	<meta property="og:title" content="{view.name} ({view.symbol}) | TokenKrafter" />
</svelte:head>

<div class="max-w-180 mx-auto px-5 pt-8 pb-20 relative">
	<!-- Ambient glow -->
	<div class="fixed -top-50 left-1/2 -translate-x-1/2 w-150 h-100 bg-[radial-gradient(ellipse,rgba(0,210,255,0.04)_0%,transparent_70%)] pointer-events-none z-0"></div>

	<TradeWarningBanner
		{isHoneypot}
		{notTradingYet}
		{taxInfo}
		chainSlug={data.chainSlug}
		{tokenAddress}
	/>

	<TokenHero
		{view}
		chainName={chainInfo.name}
		explorerUrl={chainInfo.explorer}
		{effectivePrice}
		{priceChange24h}
		{geckoLoading}
		{fmtPrice}
	/>

	<FeatureBadges
		{view}
		{tokenAddress}
		chainSlug={data.chainSlug}
		{launchAddress}
		{copied}
		onCopyAddress={copyAddress}
	/>

	<StatsStrip
		{view}
		{pools}
		{effectivePrice}
		{mcap}
		{volume24h}
		{fmtMcap}
		{fmtVol}
		{fmtSupply}
	/>

	<TaxPanel
		{taxInfo}
		isTaxable={view.isTaxable}
		{isHoneypot}
		{notTradingYet}
		{antiSnipeLock}
		{antiSnipeSeconds}
	/>

	<ProtectionPanel
		{protection}
		decimals={view.decimals}
		{fmtSupply}
	/>

	<TaxDistributionPanel
		{taxDistribution}
	/>

	<!-- Action bar — primary Trade CTA + dense icon chips. On narrow
	     viewports the secondary buttons collapse to icons to keep the
	     whole row on one line. -->
	<div class="flex items-stretch gap-1.5 mb-5">
		{#if view.hasLiquidity}
			<a href="/trade?token={tokenAddress}" class="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-linear-to-br from-cyan/12 to-success/12 border border-cyan/20 text-cyan syne font-bold text-xs2 cursor-pointer transition-all duration-150 no-underline hover:shadow-[0_4px_16px_rgba(0,210,255,0.18)] hover:from-cyan/20 hover:to-success/20 min-w-0">
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
				<span class="truncate">{$t('explore.detail.tradeSymbol').replace('{symbol}', view.symbol)}</span>
			</a>
		{/if}
		<button class="shrink-0 inline-flex items-center justify-center gap-1 px-2.5 py-2 rounded-lg border border-(--border) bg-(--bg-surface) text-(--text-dim) font-mono text-3xs cursor-pointer transition-all duration-150 hover:bg-(--bg-surface-hover) hover:text-(--text) hover:border-(--border-input)" onclick={addToWallet} aria-label={$t('explore.detail.wallet')} title={$t('explore.detail.wallet')}>
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>
			<span class="hidden sm:inline">{addedToWallet ? $t('explore.detail.added') : $t('explore.detail.wallet')}</span>
		</button>
		<a href="{chainInfo.explorer}/token/{tokenAddress}" target="_blank" rel="noopener" class="shrink-0 inline-flex items-center justify-center gap-1 px-2.5 py-2 rounded-lg border border-(--border) bg-(--bg-surface) text-(--text-dim) font-mono text-3xs cursor-pointer transition-all duration-150 no-underline hover:bg-(--bg-surface-hover) hover:text-(--text) hover:border-(--border-input)" aria-label={$t('explore.detail.explorer')} title={$t('explore.detail.explorer')}>
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
			<span class="hidden sm:inline">{$t('explore.detail.explorer')}</span>
		</a>
		<button class="shrink-0 inline-flex items-center justify-center gap-1 px-2.5 py-2 rounded-lg border border-(--border) bg-(--bg-surface) text-(--text-dim) font-mono text-3xs cursor-pointer transition-all duration-150 hover:bg-(--bg-surface-hover) hover:text-(--text) hover:border-(--border-input)" onclick={shareUrl} aria-label={$t('explore.detail.share')} title={$t('explore.detail.share')}>
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
			<span class="hidden sm:inline">{copiedUrl ? $t('explore.detail.copied') : $t('explore.detail.share')}</span>
		</button>
		{#if isCreator && view.isOnPlatform}
			<a href="/manage-tokens/{data.chainSlug}/{tokenAddress}" class="shrink-0 inline-flex items-center justify-center gap-1 px-2.5 py-2 rounded-lg bg-[rgba(168,85,247,0.1)] border border-[rgba(168,85,247,0.22)] text-[#a855f7] syne font-bold text-3xs cursor-pointer transition-all duration-150 no-underline hover:bg-[rgba(168,85,247,0.16)]" aria-label={$t('explore.detail.manage')} title={$t('explore.detail.manage')}>
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 15.5A3.5 3.5 0 1 0 12 8.5a3.5 3.5 0 0 0 0 7z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
				<span class="hidden sm:inline">{$t('explore.detail.manage')}</span>
			</a>
		{/if}
	</div>

	<PoolsList
		{pools}
		activePools={view.activePools}
		tokenSymbol={view.symbol}
		tokenDecimals={view.decimals}
		explorerUrl={chainInfo.explorer}
		{fmtSupply}
	/>

	<!-- About -->
	{#if view.description}
		<section class="mb-7">
			<h2 class="syne text-sm2 font-bold text-(--text-dim) uppercase tracking-wide m-0 mb-3">{$t('explore.detail.about')}</h2>
			<p class="font-mono text-xs text-(--text-dim) leading-relaxed m-0 mb-3">{view.description}</p>
		</section>
	{/if}

	<ContractInfo
		{view}
		{tokenAddress}
		explorerUrl={chainInfo.explorer}
	/>
</div>
