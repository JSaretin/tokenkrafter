<script lang="ts">
	import { t } from '$lib/i18n';
	import { formatTokens, formatUsdt } from '$lib/launchpad';

	let {
		userTokensBought,
		userBasePaid,
		currentPrice,
		tokenSymbol,
		tokenDecimals,
		usdtDecimals,
		maxBuyPerWallet,
		remainingBuyUsdt,
		atMaxBuy
	}: {
		userTokensBought: bigint;
		userBasePaid: bigint;
		currentPrice: bigint;
		tokenSymbol: string;
		tokenDecimals: number;
		usdtDecimals: number;
		maxBuyPerWallet: bigint;
		remainingBuyUsdt: bigint;
		atMaxBuy: boolean;
	} = $props();

	let ud = $derived(usdtDecimals);
	let avgPrice = $derived(
		userTokensBought > 0n ? (userBasePaid * BigInt(10 ** tokenDecimals)) / userTokensBought : 0n
	);
	let currentVal = $derived(
		currentPrice > 0n ? (userTokensBought * currentPrice) / BigInt(10 ** tokenDecimals) : 0n
	);
	let pnl = $derived(currentVal > 0n ? currentVal - userBasePaid : 0n);
	let pnlPct = $derived(userBasePaid > 0n ? Number((pnl * 10000n) / userBasePaid) / 100 : 0);
	let isUp = $derived(pnl > 0n);
</script>

<div class="card p-5 mb-4">
	<div class="flex items-center justify-between mb-2">
		<h3 class="syne text-sm2 font-extrabold text-(--text-heading)">{$t('lpd.yourBag')}</h3>
		{#if currentVal > 0n}
			<span class={"rajdhani text-sm2 font-bold py-0.5 px-2 rounded-md " + (isUp ? "text-success bg-success/10" : pnl < 0n ? "text-danger-light bg-danger-light/10" : "")}>
				{isUp ? '+' : ''}{pnlPct.toFixed(1)}%
			</span>
		{/if}
	</div>

	<div class="mb-3.5">
		<span class="syne text-2xl2 font-extrabold text-(--text-heading)">{formatTokens(userTokensBought, tokenDecimals)}</span>
		<span class="rajdhani text-sm font-semibold text-(--text-muted) ml-1.5">{tokenSymbol}</span>
	</div>

	<div class="grid grid-cols-2 gap-2 mb-3.5">
		<div class="py-2 px-2.5 rounded-lg bg-(--bg-surface-hover)">
			<span class="block rajdhani text-xs2 text-(--text-dim) uppercase tracking-wide mb-0.5">{$t('lpd.spent')}</span>
			<span class="block syne text-sm font-bold text-(--text-heading)">{formatUsdt(userBasePaid, ud)}</span>
		</div>
		{#if currentVal > 0n}
			<div class="py-2 px-2.5 rounded-lg bg-(--bg-surface-hover)">
				<span class="block rajdhani text-xs2 text-(--text-dim) uppercase tracking-wide mb-0.5">{$t('lpd.valueNow')}</span>
				<span class={"block syne text-sm font-bold " + (isUp ? "text-success" : "text-(--text-heading)")}>{formatUsdt(currentVal, ud)}</span>
			</div>
		{/if}
		{#if avgPrice > 0n}
			<div class="py-2 px-2.5 rounded-lg bg-(--bg-surface-hover)">
				<span class="block rajdhani text-xs2 text-(--text-dim) uppercase tracking-wide mb-0.5">{$t('lpd.avgPriceLabel')}</span>
				<span class="block syne text-sm font-bold text-(--text-heading)">{formatUsdt(avgPrice, ud, 6)}</span>
			</div>
		{/if}
		<div class="py-2 px-2.5 rounded-lg bg-(--bg-surface-hover)">
			<span class="block rajdhani text-xs2 text-(--text-dim) uppercase tracking-wide mb-0.5">{$t('lpd.priceNow')}</span>
			<span class="block syne text-sm font-bold text-(--text-heading)">{formatUsdt(currentPrice, ud, 6)}</span>
		</div>
	</div>

	{#if maxBuyPerWallet > 0n && remainingBuyUsdt > 0n && !atMaxBuy}
		<div class="pt-2.5 border-t border-(--border-subtle) font-mono text-xs2 text-(--text-muted) text-center">
			{$t('lpd.leftToBuy').replace('{amount}', formatUsdt(remainingBuyUsdt, ud))}
		</div>
	{:else if maxBuyPerWallet > 0n && atMaxBuy}
		<div class="pt-2.5 border-t border-(--border-subtle) font-mono text-xs2 text-success text-center">
			✓ {$t('lpd.fullAllocation').replace('{amount}', formatUsdt(maxBuyPerWallet, ud))}
		</div>
	{/if}
</div>
