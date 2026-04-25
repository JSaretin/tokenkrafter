<script lang="ts">
	import { t } from '$lib/i18n';
	import { shortAddr } from '$lib/formatters';
	import type { ExploreView } from '$lib/structure/views/exploreView';

	let {
		view,
		tokenAddress,
		chainName,
		explorerUrl,
		effectivePrice,
		priceChange24h,
		geckoLoading,
		fmtPrice,
		onShare,
		copiedUrl,
	}: {
		view: ExploreView;
		tokenAddress: string;
		chainName: string;
		explorerUrl: string;
		effectivePrice: number;
		priceChange24h: number;
		geckoLoading: boolean;
		fmtPrice: (v: number) => string;
		onShare: () => void;
		copiedUrl: boolean;
	} = $props();

	// Resolve social URLs (handles raw handles like "@elonmusk")
	let websiteUrl = $derived(view.website ? (view.website.startsWith('http') ? view.website : 'https://' + view.website) : '');
	let twitterUrl = $derived(view.twitter ? (view.twitter.startsWith('http') ? view.twitter : 'https://x.com/' + view.twitter.replace('@', '')) : '');
	let telegramUrl = $derived(view.telegram ? (view.telegram.startsWith('http') ? view.telegram : 'https://t.me/' + view.telegram.replace('@', '')) : '');
	let hasAnySocial = $derived(!!(view.website || view.twitter || view.telegram));
</script>

<header class="relative z-1 mb-6">
	<!-- Top row: logo + name + chain/symbol pills + price -->
	<div class="flex items-start gap-4 max-[540px]:gap-3.5">
		{#if view.logoUrl}
			<img src={view.logoUrl} alt={view.symbol} class="w-20 h-20 max-[540px]:w-16 max-[540px]:h-16 rounded-2xl max-[540px]:rounded-2xl object-cover border-2 border-(--border) shrink-0 shadow-[0_0_32px_rgba(0,210,255,0.12)]" />
		{:else}
			<div class="w-20 h-20 max-[540px]:w-16 max-[540px]:h-16 rounded-2xl shrink-0 shadow-[0_0_32px_rgba(0,210,255,0.12)] bg-linear-to-br from-[#0c1220] to-[#0a1628] border-2 border-cyan/15 flex items-center justify-center">
				<span class="syne text-2xl max-[540px]:text-xl font-extrabold bg-linear-to-br from-cyan to-success bg-clip-text text-transparent">{view.symbol.slice(0, 2)}</span>
			</div>
		{/if}

		<div class="flex-1 min-w-0">
			<h1 class="heading-1 leading-tight tracking-tight break-words">{view.name}</h1>

			<!-- Symbol + chain + platform pills -->
			<div class="flex items-center gap-1.5 mt-2 flex-wrap">
				<span class="font-mono text-xs2 font-bold text-cyan bg-cyan/8 px-2 py-0.5 rounded-md border border-cyan/15">${view.symbol}</span>
				<span class="font-mono text-3xs px-2 py-0.5 rounded bg-warning/8 text-[#b45309] border border-warning/10 uppercase tracking-wide">{chainName}</span>
				{#if view.isOnPlatform}<span class="font-mono text-3xs px-2 py-0.5 rounded bg-cyan/6 text-[#0891b2] font-bold border border-cyan/10 uppercase tracking-wide">{$t('explore.detail.platformLabel')}</span>{/if}
				{#if view.hasLiquidity}
					<span class="inline-flex items-center gap-1 font-mono text-3xs font-bold text-success px-2 py-0.5 rounded bg-success/8 border border-success/15 uppercase tracking-wide">
						<span class="w-1.5 h-1.5 rounded-full bg-success shadow-[0_0_6px_#10b981] animate-pulse-glow"></span>
						{$t('explore.detail.tradeable')}
					</span>
				{/if}
			</div>

			<!-- Creator attribution -->
			{#if view.creator}
				<div class="mt-2 font-mono text-xs2 text-(--text-dim)">
					{$t('explore.detail.createdBy')}
					<a
						href="{explorerUrl}/address/{view.creator}"
						target="_blank"
						rel="noopener"
						class="text-cyan no-underline hover:underline"
						title={view.creator}
					>{shortAddr(view.creator)}</a>
				</div>
			{/if}
		</div>

		<!-- Price block (desktop right rail) -->
		<div class="shrink-0 hidden sm:flex flex-col items-end gap-1">
			{#if effectivePrice > 0}
				<span class="rajdhani text-2xl font-bold text-(--text-heading) leading-tight">{fmtPrice(effectivePrice)}</span>
				{#if priceChange24h !== 0}
					<span class={'rajdhani text-sm2 font-semibold ' + (priceChange24h > 0 ? 'text-success' : priceChange24h < 0 ? 'text-danger-light' : '')}>
						{priceChange24h > 0 ? '+' : ''}{priceChange24h.toFixed(1)}%
					</span>
				{/if}
			{:else if !geckoLoading}
				<span class="font-mono text-3xs text-(--text-dim)">{$t('explore.detail.noPriceData')}</span>
			{/if}
		</div>
	</div>

	<!-- Mobile price row — sits under the name block on narrow screens -->
	{#if effectivePrice > 0}
		<div class="sm:hidden flex items-baseline gap-2 mt-3">
			<span class="rajdhani text-2xl font-bold text-(--text-heading) leading-tight">{fmtPrice(effectivePrice)}</span>
			{#if priceChange24h !== 0}
				<span class={'rajdhani text-sm2 font-semibold ' + (priceChange24h > 0 ? 'text-success' : priceChange24h < 0 ? 'text-danger-light' : '')}>
					{priceChange24h > 0 ? '+' : ''}{priceChange24h.toFixed(1)}%
				</span>
			{/if}
		</div>
	{/if}

	<!-- Manifesto / description — promoted from the bottom into the hero. -->
	{#if view.description}
		<p class="font-sans text-15 text-(--text-muted) leading-relaxed max-w-prose mt-5 mb-0 whitespace-pre-line">{view.description}</p>
	{/if}

	<!-- Social pills — proper buttons with text + icon, not corner micro-icons. -->
	{#if hasAnySocial}
		<div class="flex flex-wrap gap-2 mt-5">
			{#if websiteUrl}
				<a
					href={websiteUrl}
					target="_blank"
					rel="noopener"
					class="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-(--bg-surface) border border-(--border-subtle) text-(--text) syne text-xs2 font-semibold no-underline transition-all duration-150 hover:border-cyan/30 hover:bg-cyan/4 hover:text-cyan"
				>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
					{$t('explore.detail.website')}
				</a>
			{/if}
			{#if twitterUrl}
				<a
					href={twitterUrl}
					target="_blank"
					rel="noopener"
					class="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-(--bg-surface) border border-(--border-subtle) text-(--text) syne text-xs2 font-semibold no-underline transition-all duration-150 hover:border-cyan/30 hover:bg-cyan/4 hover:text-cyan"
				>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" class="shrink-0"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
					{$t('explore.detail.twitter')}
				</a>
			{/if}
			{#if telegramUrl}
				<a
					href={telegramUrl}
					target="_blank"
					rel="noopener"
					class="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-(--bg-surface) border border-(--border-subtle) text-(--text) syne text-xs2 font-semibold no-underline transition-all duration-150 hover:border-cyan/30 hover:bg-cyan/4 hover:text-cyan"
				>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" class="shrink-0"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
					{$t('explore.detail.telegram')}
				</a>
			{/if}
		</div>
	{/if}

	<!-- Primary CTA + secondary share — full-width Trade on mobile. -->
	<div class="flex items-stretch gap-2 mt-5">
		{#if view.hasLiquidity}
			<a
				href="/trade?token={tokenAddress}"
				class="flex-1 inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-linear-to-br from-cyan/15 to-success/15 border border-cyan/25 text-cyan syne font-bold text-base no-underline cursor-pointer transition-all duration-150 hover:shadow-[0_6px_24px_rgba(0,210,255,0.22)] hover:from-cyan/25 hover:to-success/25"
			>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
				{$t('explore.detail.tradeSymbol').replace('{symbol}', view.symbol)}
			</a>
		{:else if !geckoLoading}
			<div class="flex-1 inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl border border-(--border-subtle) bg-(--bg-surface) text-(--text-dim) font-mono text-xs2">
				{$t('explore.detail.notListed')}
			</div>
		{/if}
		<button
			class="shrink-0 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-(--border) bg-(--bg-surface) text-(--text-dim) syne font-semibold text-xs2 cursor-pointer transition-all duration-150 hover:bg-(--bg-surface-hover) hover:text-(--text) hover:border-(--border-input)"
			onclick={onShare}
			aria-label={$t('explore.detail.shareToken')}
		>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
			<span class="hidden sm:inline">{copiedUrl ? $t('explore.detail.copiedUrl') : $t('explore.detail.shareToken')}</span>
		</button>
	</div>
</header>
