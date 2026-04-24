<script lang="ts">
	import { t } from '$lib/i18n';
	import type { TaxInfo } from '$lib/tradeLens';

	let {
		taxInfo,
		isTaxable = false,
		isHoneypot,
		notTradingYet,
		antiSnipeLock,
		antiSnipeSeconds,
	}: {
		taxInfo: TaxInfo | null;
		isTaxable?: boolean;
		isHoneypot: boolean;
		notTradingYet: boolean;
		antiSnipeLock: boolean;
		antiSnipeSeconds: number;
	} = $props();

	// Tax-simulation card is only meaningful when the token actually has a
	// tax surface (declared taxable) OR when a non-zero tax was observed in
	// the simulation. For vanilla non-taxable tokens it's just noise —
	// honeypot / not-trading warnings live in TradeWarningBanner anyway.
	let hasTax = $derived(!!taxInfo && (
		taxInfo.buyTaxBps > 0 ||
		taxInfo.sellTaxBps > 0 ||
		taxInfo.transferTaxBps > 0
	));
	let show = $derived(!!taxInfo && (isTaxable || hasTax || antiSnipeLock));
</script>

{#if show && taxInfo}
	<div class="bg-warning/2 border border-warning/10 rounded-xl overflow-hidden mb-4">
		<div class="flex items-center gap-2 px-4 py-2.5 border-b border-warning/8 syne text-xs3 font-bold text-[#92400e] uppercase tracking-wide">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
			<span>{$t('explore.detail.taxSimulation')}</span>
		</div>
		<div class="flex max-[540px]:flex-col">
			<div class="flex-1 px-4 py-3 border-r border-warning/6 max-[540px]:border-r-0 max-[540px]:border-b max-[540px]:border-b-warning/6">
				<span class="block font-mono text-xxs text-[#78350f] uppercase tracking-wide mb-1">{$t('explore.detail.taxBuy')}</span>
				<span class={'rajdhani text-xl font-bold ' + (taxInfo.buyTaxBps === 0 ? 'text-success' : 'text-warning')}>{(taxInfo.buyTaxBps / 100).toFixed(1)}%</span>
			</div>
			<div class="flex-1 px-4 py-3 border-r border-warning/6 max-[540px]:border-r-0 max-[540px]:border-b max-[540px]:border-b-warning/6">
				<span class="block font-mono text-xxs text-[#78350f] uppercase tracking-wide mb-1">{$t('explore.detail.taxSell')}</span>
				<span class={'rajdhani text-xl font-bold ' + (taxInfo.sellTaxBps === 0 ? 'text-success' : 'text-warning')}>{(taxInfo.sellTaxBps / 100).toFixed(1)}%</span>
			</div>
			<div class="flex-1 px-4 py-3">
				<span class="block font-mono text-xxs text-[#78350f] uppercase tracking-wide mb-1">{$t('explore.detail.taxTransfer')}</span>
				<span class={'rajdhani text-xl font-bold ' + (taxInfo.transferTaxBps === 0 ? 'text-success' : 'text-warning')}>{taxInfo.transferTaxBps === 0 ? $t('explore.detail.taxFree') : (taxInfo.transferTaxBps / 100).toFixed(1) + '%'}</span>
			</div>
		</div>
		{#if antiSnipeLock}
			<div class="px-4 py-2 border-t border-warning/10 font-mono text-xs2 text-warning bg-warning/3">{$t('explore.detail.antiSnipe').replace('{min}', String(Math.ceil(antiSnipeSeconds / 60)))}</div>
		{:else if !taxInfo.canBuy && !isHoneypot && !notTradingYet}
			<div class="px-4 py-2 border-t border-danger/10 font-mono text-xs2 text-danger-light bg-danger/3">{$t('explore.detail.cannotBuy').replace('{error}', taxInfo.buyError || $t('explore.detail.revertsErr'))}</div>
		{/if}
		{#if !taxInfo.canSell && !isHoneypot && !notTradingYet && !antiSnipeLock}
			<div class="px-4 py-2 border-t border-danger/10 font-mono text-xs2 text-danger-light bg-danger/3">{$t('explore.detail.cannotSell').replace('{error}', taxInfo.sellError || $t('explore.detail.honeypotErr'))}</div>
		{/if}
	</div>
{/if}
