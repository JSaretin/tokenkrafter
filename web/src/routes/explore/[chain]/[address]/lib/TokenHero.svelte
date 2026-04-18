<script lang="ts">
	import { t } from '$lib/i18n';
	import { shortAddr } from '$lib/formatters';
	import type { ExploreView } from '$lib/structure/views/exploreView';

	let {
		view,
		chainName,
		explorerUrl,
		effectivePrice,
		priceChange24h,
		geckoLoading,
		fmtPrice,
	}: {
		view: ExploreView;
		chainName: string;
		explorerUrl: string;
		effectivePrice: number;
		priceChange24h: number;
		geckoLoading: boolean;
		fmtPrice: (v: number) => string;
	} = $props();
</script>

<header class="flex justify-between items-start gap-4 mb-4 relative z-1 max-[540px]:flex-col max-[540px]:gap-3">
	<div class="flex items-center gap-4 min-w-0">
		{#if view.logoUrl}
			<img src={view.logoUrl} alt={view.symbol} class="w-16 h-16 max-[540px]:w-13 max-[540px]:h-13 rounded-2xl max-[540px]:rounded-[14px] object-cover border-2 border-(--border) shrink-0 shadow-[0_0_24px_rgba(0,210,255,0.08)]" />
		{:else}
			<div class="w-16 h-16 max-[540px]:w-13 max-[540px]:h-13 rounded-2xl max-[540px]:rounded-[14px] shrink-0 shadow-[0_0_24px_rgba(0,210,255,0.08)] bg-linear-to-br from-[#0c1220] to-[#0a1628] border-2 border-cyan/15 flex items-center justify-center">
				<span class="syne text-[22px] font-extrabold bg-linear-to-br from-cyan to-success bg-clip-text text-transparent">{view.symbol.slice(0, 2)}</span>
			</div>
		{/if}
		<div>
			<h1 class="syne text-[26px] max-[540px]:text-[22px] font-extrabold text-(--text-heading) m-0 leading-tight tracking-tight">{view.name}</h1>
			<div class="flex items-center gap-1.5 mt-1.5 flex-wrap">
				<span class="font-mono text-xs3 text-(--text-dim) bg-(--bg-surface) px-2 py-0.5 rounded border border-(--border-subtle)">{view.symbol}</span>
				<span class="font-mono text-xxs px-2 py-0.5 rounded bg-warning/8 text-[#b45309] border border-warning/10">{chainName}</span>
				{#if view.isOnPlatform}<span class="font-mono text-xxs px-2 py-0.5 rounded bg-cyan/6 text-[#0891b2] font-bold border border-cyan/10">{$t('explore.detail.platformLabel')}</span>{/if}
				{#if view.creator}
					<a href="{explorerUrl}/address/{view.creator}" target="_blank" rel="noopener" class="font-mono text-xxs px-2 py-0.5 rounded bg-(--bg-surface) text-(--text-dim) border border-(--border-subtle) no-underline transition-all duration-150 hover:text-cyan hover:border-cyan/20" title={view.creator}>
						{shortAddr(view.creator)}
					</a>
				{/if}
			</div>
			{#if view.website || view.twitter || view.telegram}
				<div class="flex items-center gap-1.5 mt-1.5">
					{#if view.website}
						<a href={view.website.startsWith('http') ? view.website : 'https://' + view.website} target="_blank" rel="noopener" class="w-6.5 h-6.5 rounded-md flex items-center justify-center bg-(--bg-surface) border border-(--border-subtle) text-(--text-dim) transition-all duration-150 no-underline hover:text-cyan hover:border-cyan/30 hover:bg-cyan/6" title={$t('explore.websiteTitle')}>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
						</a>
					{/if}
					{#if view.twitter}
						<a href={view.twitter.startsWith('http') ? view.twitter : 'https://x.com/' + view.twitter.replace('@', '')} target="_blank" rel="noopener" class="w-6.5 h-6.5 rounded-md flex items-center justify-center bg-(--bg-surface) border border-(--border-subtle) text-(--text-dim) transition-all duration-150 no-underline hover:text-cyan hover:border-cyan/30 hover:bg-cyan/6" title={$t('explore.twitterTitle')}>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
						</a>
					{/if}
					{#if view.telegram}
						<a href={view.telegram.startsWith('http') ? view.telegram : 'https://t.me/' + view.telegram.replace('@', '')} target="_blank" rel="noopener" class="w-6.5 h-6.5 rounded-md flex items-center justify-center bg-(--bg-surface) border border-(--border-subtle) text-(--text-dim) transition-all duration-150 no-underline hover:text-cyan hover:border-cyan/30 hover:bg-cyan/6" title={$t('explore.telegramTitle')}>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
						</a>
					{/if}
				</div>
			{/if}
		</div>
	</div>

	<div class="shrink-0 flex flex-col items-end gap-1.5 max-[540px]:self-start">
		{#if effectivePrice > 0}
			<div class="flex flex-col items-end">
				<span class="rajdhani text-2xl font-bold text-(--text-heading) leading-tight">{fmtPrice(effectivePrice)}</span>
				{#if priceChange24h !== 0}
					<span class={'rajdhani text-sm2 font-semibold ' + (priceChange24h > 0 ? 'text-success' : priceChange24h < 0 ? 'text-danger-light' : '')}>
						{priceChange24h > 0 ? '+' : ''}{priceChange24h.toFixed(1)}%
					</span>
				{/if}
			</div>
		{:else if !geckoLoading}
			<div class="font-mono text-xs3 text-(--text-dim) px-3.5 py-2 rounded-[10px] border border-(--border-subtle)">{$t('explore.detail.noPriceData')}</div>
		{/if}
		{#if view.hasLiquidity}
			<div class="flex items-center gap-1.5 font-mono text-xs2 font-bold text-success px-3 py-1.25 rounded-md bg-success/6 border border-success/12 uppercase tracking-wide">
				<span class="w-1.5 h-1.5 rounded-full bg-success shadow-[0_0_6px_#10b981] animate-pulse-glow"></span>
				{$t('explore.detail.tradeable')}
			</div>
		{:else}
			<div class="font-mono text-xs3 text-(--text-dim) px-3.5 py-2 rounded-[10px] border border-(--border-subtle)">{$t('explore.detail.notListed')}</div>
		{/if}
	</div>
</header>
