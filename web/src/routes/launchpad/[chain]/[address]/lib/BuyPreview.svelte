<script lang="ts">
	import { t } from '$lib/i18n';
	import { formatUsdt, formatTokens } from '$lib/launchpad';
	import type { BuyPreview } from '$lib/launchpad';

	let {
		preview,
		previewLoading,
		previewError,
		tokenDecimals,
		tokenSymbol,
		usdtDecimals,
		maxBuyPerWallet,
		maxBuyPct,
	}: {
		preview: BuyPreview | null;
		previewLoading: boolean;
		previewError: string;
		tokenDecimals: number;
		tokenSymbol: string;
		usdtDecimals: number;
		maxBuyPerWallet: bigint;
		maxBuyPct: number;
	} = $props();
</script>

<!-- Preview -->
{#if preview && !previewLoading}
	<div class="p-3 bg-cyan-400/[0.03] border border-cyan-400/10 rounded-[10px] flex flex-col gap-2 mb-4">
		{#if previewError === 'estimate'}
			<div class="text-amber-400 text-xs2 font-mono text-center pb-1">
				{$t('lpd.approxEstimate')}
			</div>
		{/if}
		<div class="flex justify-between text-xs font-mono">
			<span class="text-gray-500">{$t('lpd.youReceive')}</span>
			<span class="text-white font-semibold">
				{previewError === 'estimate' ? '~' : ''}{formatTokens(preview.tokensOut, tokenDecimals)} {tokenSymbol}
			</span>
		</div>
		<div class="flex justify-between text-xs font-mono">
			<span class="text-gray-500">{$t('lpd.buyFeeLine')}</span>
			<span class="text-amber-400">{preview.fee > 0n ? formatUsdt(preview.fee, usdtDecimals) : $t('lpd.feeNone')}</span>
		</div>
		{#if preview.priceImpactBps > 0n}
			<div class="flex justify-between text-xs font-mono">
				<span class="text-gray-500">{$t('lpd.priceImpact')}</span>
				<span class="text-emerald-400">
					{(Number(preview.priceImpactBps) / 100).toFixed(2)}%
					{#if Number(preview.priceImpactBps) > 500}
						· {$t('lpd.earlyEntry')}
					{/if}
				</span>
			</div>
		{/if}
		{#if maxBuyPerWallet > 0n}
			<div class="flex justify-between text-xs font-mono">
				<span class="text-gray-500">{$t('lpd.maxBuyPerWalletLine')}</span>
				<span class="text-cyan-300">{formatUsdt(maxBuyPerWallet, usdtDecimals)} ({maxBuyPct}%)</span>
			</div>
		{/if}
	</div>
{:else if previewLoading}
	<div class="p-3 bg-cyan-400/[0.03] border border-cyan-400/10 rounded-[10px] flex flex-col gap-2 mb-4">
		<div class="text-gray-500 text-xs font-mono text-center py-2">{$t('lpd.calculating')}</div>
	</div>
{:else if previewError && previewError !== 'estimate'}
	<div class="py-2 px-3 bg-red-500/[0.06] border border-red-500/15 rounded-lg mb-4">
		<span class="text-red-400 text-xs font-mono">{previewError}</span>
	</div>
{/if}
