<script lang="ts">
	import { t } from '$lib/i18n';
	import { formatUsdt, formatTokens } from '$lib/launchpad';
	import type { LaunchInfo } from '$lib/launchpad';
	import RefundPanel from './RefundPanel.svelte';
	import CreatorReclaimPanel from './CreatorReclaimPanel.svelte';
	import PlatformSweepPanel from './PlatformSweepPanel.svelte';

	let {
		launch,
		userAddress,
		userBasePaid,
		userTokensBought,
		tokenDecimals,
		usdtDecimals,
		tokenSymbol,
		isCreator,
		isPlatformWallet,
		reclaimableBalance,
		strandedUsdtBalance,
		sweepWindowOpen,
		isReclaiming,
		isRefunding,
		isSweeping,
		refundStartTimestamp = 0n,
		strandedSweepDelay = 0n,
		onRefund,
		onReclaim,
		onSweep,
	}: {
		launch: LaunchInfo;
		userAddress: string | null;
		userBasePaid: bigint;
		userTokensBought: bigint;
		tokenDecimals: number;
		usdtDecimals: number;
		tokenSymbol: string;
		isCreator: boolean;
		isPlatformWallet: boolean;
		reclaimableBalance: bigint;
		strandedUsdtBalance: bigint;
		sweepWindowOpen: boolean;
		isReclaiming: boolean;
		isRefunding: boolean;
		isSweeping: boolean;
		refundStartTimestamp?: bigint;
		strandedSweepDelay?: bigint;
		onRefund: () => Promise<void>;
		onReclaim: () => Promise<void>;
		onSweep: () => Promise<void>;
	} = $props();

	let hasPosition = $derived(!!userAddress && (userBasePaid > 0n || userTokensBought > 0n));
	let avgPriceDisplay = $derived(
		userTokensBought > 0n && userBasePaid > 0n
			? formatUsdt((userBasePaid * BigInt(10 ** tokenDecimals)) / userTokensBought, usdtDecimals, 6)
			: ''
	);
	let showRefundPanel = $derived(launch.state === 3 && userBasePaid > 0n);
	let showCreatorReclaim = $derived(
		launch.state === 3 && !!userAddress && isCreator
	);
	let showPlatformSweep = $derived(
		launch.state === 3 && isPlatformWallet && strandedUsdtBalance > 0n
	);
</script>

{#if hasPosition}
	<div class="card p-6 mb-4">
		<h3 class="syne font-bold text-white mb-4">{$t('lpd.yourPosition')}</h3>
		<div class="detail-grid">
			<div class="detail-row">
				<span class="detail-label">{$t('lpd.tokensBought')}</span>
				<span class="detail-value">{formatTokens(userTokensBought, tokenDecimals)} {tokenSymbol}</span>
			</div>
			<div class="detail-row">
				<span class="detail-label">{$t('lpd.totalSpent')}</span>
				<span class="detail-value">{formatUsdt(userBasePaid, usdtDecimals)}</span>
			</div>
			{#if avgPriceDisplay}
				<div class="detail-row">
					<span class="detail-label">{$t('lpd.avgPrice')}</span>
					<span class="detail-value">{avgPriceDisplay}</span>
				</div>
			{/if}
		</div>

		{#if showRefundPanel}
			<RefundPanel
				{userBasePaid}
				{userTokensBought}
				{tokenDecimals}
				{usdtDecimals}
				{tokenSymbol}
				{isRefunding}
				{onRefund}
			/>
		{/if}
	</div>
{/if}

<!-- Creator Reclaim (Refunding state only).
     Stranded-USDT sweep was previously rendered inside this
     panel but moved to its own platform-gated panel below,
     since the L2 audit fix made sweepStrandedUsdt() platform-
     only on-chain — the creator button would revert. -->
{#if showCreatorReclaim}
	<CreatorReclaimPanel
		{reclaimableBalance}
		{tokenDecimals}
		{tokenSymbol}
		{isReclaiming}
		{onReclaim}
	/>
{/if}

<!-- Platform stranded-USDT sweep (Refunding state, platform
     wallet only). Appears after the 90-day refund window
     closes, when there's still USDT sitting on the launch
     that nobody claimed. Sends the balance to the platform
     wallet. On-chain: LaunchInstance.sweepStrandedUsdt(). -->
{#if showPlatformSweep}
	<PlatformSweepPanel
		{strandedUsdtBalance}
		{usdtDecimals}
		{sweepWindowOpen}
		{isSweeping}
		{refundStartTimestamp}
		{strandedSweepDelay}
		{onSweep}
	/>
{/if}
