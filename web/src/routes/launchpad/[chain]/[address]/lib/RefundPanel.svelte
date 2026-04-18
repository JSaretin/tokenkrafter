<script lang="ts">
	import { t } from '$lib/i18n';
	import { formatUsdt, formatTokens } from '$lib/launchpad';

	let {
		userBasePaid,
		userTokensBought,
		tokenDecimals,
		usdtDecimals,
		tokenSymbol,
		isRefunding,
		onRefund,
	}: {
		userBasePaid: bigint;
		userTokensBought: bigint;
		tokenDecimals: number;
		usdtDecimals: number;
		tokenSymbol: string;
		isRefunding: boolean;
		onRefund: () => Promise<void>;
	} = $props();
</script>

<div class="card p-4 mt-4 mb-2 border-danger/20 bg-danger/[0.04]">
	<div class="detail-grid mb-3">
		<div class="detail-row">
			<span class="detail-label">{$t('lpd.yourUsdtPaid')}</span>
			<span class="detail-value text-red-400">{formatUsdt(userBasePaid, usdtDecimals)}</span>
		</div>
		<div class="detail-row">
			<span class="detail-label">{$t('lpd.tokensToReturn')}</span>
			<span class="detail-value">{formatTokens(userTokensBought, tokenDecimals)} {tokenSymbol}</span>
		</div>
	</div>
	<button
		onclick={onRefund}
		disabled={isRefunding}
		class="btn-danger w-full py-2.5 text-sm cursor-pointer"
	>
		{isRefunding ? $t('lpd.processing') : `${$t('common.refund')} ${formatUsdt(userBasePaid, usdtDecimals)}`}
	</button>
	<p class="text-gray-600 text-xs2 font-mono mt-2">
		{$t('lpd.refundReturnNote')}
	</p>
</div>
