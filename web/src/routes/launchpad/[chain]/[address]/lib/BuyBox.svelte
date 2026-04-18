<script lang="ts">
	import { ethers } from 'ethers';
	import { t } from '$lib/i18n';
	import TokenPickerModal, { type PickerToken } from '$lib/TokenPickerModal.svelte';
	import { formatUsdt } from '$lib/launchpad';
	import type { BuyPreview as BuyPreviewType, LaunchInfo } from '$lib/launchpad';
	import BuyAmountInput from './BuyAmountInput.svelte';
	import PaymentMethodPicker from './PaymentMethodPicker.svelte';
	import SlippageMenu from './SlippageMenu.svelte';
	import RemainingBuyIndicator from './RemainingBuyIndicator.svelte';
	import BuyPreviewPanel from './BuyPreview.svelte';

	let {
		launch,
		buyAmount = $bindable(''),
		buyPaymentMethod = $bindable('usdt'),
		customPayToken,
		paySymbol,
		paymentLabel,
		payTokens,
		showPayPicker = $bindable(false),
		preview,
		previewLoading,
		previewError,
		isBuying,
		slippageBps = $bindable(500),
		showSlippageMenu = $bindable(false),
		maxBuyPerWallet,
		userBasePaid,
		remainingBuyUsdt,
		allocationPct,
		atMaxBuy,
		exceedsMaxBuy,
		belowMinBuy,
		minBuyUsdt,
		minBuyLabel,
		maxBuyPct,
		swapEstimate,
		swapEstimateLoading,
		usdtDecimals,
		tokenDecimals,
		tokenSymbol,
		userAddress,
		notStartedYet = false,
		pickerChainId,
		pickerProvider,
		onBuy,
		onPayTokenPick,
		onConnectWallet,
	}: {
		launch: LaunchInfo;
		buyAmount: string;
		buyPaymentMethod: 'native' | 'usdt' | 'usdc' | 'custom';
		customPayToken: PickerToken | null;
		paySymbol: string;
		paymentLabel: string;
		payTokens: PickerToken[];
		showPayPicker: boolean;
		preview: BuyPreviewType | null;
		previewLoading: boolean;
		previewError: string;
		isBuying: boolean;
		slippageBps: number;
		showSlippageMenu: boolean;
		maxBuyPerWallet: bigint;
		userBasePaid: bigint;
		remainingBuyUsdt: bigint;
		allocationPct: number;
		atMaxBuy: boolean;
		exceedsMaxBuy: boolean;
		belowMinBuy: boolean;
		minBuyUsdt: bigint;
		minBuyLabel: string;
		maxBuyPct: number;
		swapEstimate: string;
		swapEstimateLoading: boolean;
		usdtDecimals: number;
		tokenDecimals: number;
		tokenSymbol: string;
		userAddress: string | null;
		notStartedYet?: boolean;
		pickerChainId: number;
		pickerProvider: ethers.Provider | null;
		onBuy: () => Promise<void>;
		onPayTokenPick: (token: PickerToken) => void;
		onConnectWallet: () => Promise<void> | Promise<boolean>;
	} = $props();

	function handleBuyClick() {
		if (!userAddress || !buyAmount) {
			onConnectWallet();
			return;
		}
		onBuy();
	}
</script>

<div class={"card p-6 mb-4 " + (notStartedYet ? "opacity-50 pointer-events-none" : "")}>
	<h3 class="syne font-bold text-white mb-4">{$t('lpd.buyTokens')}</h3>

	{#if userAddress}
		<RemainingBuyIndicator
			{maxBuyPerWallet}
			{remainingBuyUsdt}
			{allocationPct}
			{atMaxBuy}
			{usdtDecimals}
		/>
	{/if}

	<BuyAmountInput
		bind:buyAmount
		{paySymbol}
		{swapEstimate}
		{swapEstimateLoading}
	/>

	<PaymentMethodPicker
		{paySymbol}
		{buyPaymentMethod}
		onOpenPicker={() => (showPayPicker = true)}
	/>

	<TokenPickerModal
		bind:open={showPayPicker}
		tokens={payTokens}
		onPick={onPayTokenPick}
		title={$t('lpd.payWithPickerTitle')}
		chainId={pickerChainId}
		provider={pickerProvider}
		userAddress={userAddress || ''}
	/>

	<BuyPreviewPanel
		{preview}
		{previewLoading}
		{previewError}
		{tokenDecimals}
		{tokenSymbol}
		{usdtDecimals}
		{maxBuyPerWallet}
		{maxBuyPct}
	/>

	<!-- Max buy info -->
	{#if maxBuyPerWallet > 0n && userAddress}
		<div class="py-2 px-3 bg-[var(--bg-surface)] border border-[var(--bg-surface-hover)] rounded-lg mb-3">
			<div class="flex justify-between text-xs2 font-mono">
				<span class="text-gray-500">{$t('lpd.maxBuyPerWallet')}</span>
				<span class="text-gray-400">{formatUsdt(maxBuyPerWallet, usdtDecimals)} ({maxBuyPct}%)</span>
			</div>
			{#if userBasePaid > 0n}
				<div class="flex justify-between text-xs2 font-mono mt-1">
					<span class="text-gray-500">{$t('lpd.remainingLabel')}</span>
					<span class={remainingBuyUsdt === 0n ? 'text-red-400' : 'text-gray-400'}>
						{remainingBuyUsdt === 0n ? $t('lpd.limitReached') : $t('lpd.remainingSuffix').replace('{amount}', formatUsdt(remainingBuyUsdt, usdtDecimals))}
					</span>
				</div>
			{/if}
		</div>
	{/if}

	{#if exceedsMaxBuy}
		<div class="py-2 px-3 bg-red-500/[0.06] border border-red-500/15 rounded-lg mb-3">
			<span class="text-red-400 text-xs font-mono">
				{$t('lpd.exceedsMaxBuy').replace('{pct}', String(maxBuyPct))}
			</span>
		</div>
	{/if}

	{#if belowMinBuy}
		<div class="py-2 px-3 bg-red-500/[0.06] border border-red-500/15 rounded-lg mb-3">
			<span class="text-red-400 text-xs font-mono">
				{$t('lpd.belowMinBuy').replace('{min}', '$' + minBuyLabel)}
			</span>
		</div>
	{/if}

	<SlippageMenu bind:slippageBps bind:showSlippageMenu />

	{#if userAddress}
		<button
			onclick={handleBuyClick}
			disabled={isBuying || !buyAmount || parseFloat(String(buyAmount)) <= 0 || exceedsMaxBuy || atMaxBuy || belowMinBuy}
			class="btn-primary w-full py-3 text-sm cursor-pointer"
		>
			{#if atMaxBuy}
				{$t('lpd.maxBuyReached')}
			{:else if exceedsMaxBuy}
				{$t('lpd.exceedsMaxBuyBtn')}
			{:else if belowMinBuy}
				{$t('lpd.belowMinBuy').replace('{min}', '$' + minBuyLabel)}
			{:else}
				{isBuying ? $t('lpd.buying') : `${$t('lpd.buyWith')} ${paymentLabel}`}
			{/if}
		</button>
	{:else}
		<div class="pt-2 border-t border-[var(--bg-surface-hover)] mt-2">
			<p class="text-gray-500 text-xs font-mono mb-3 text-center">{$t('lpd.connectToParticipate')}</p>
			<button onclick={onConnectWallet} class="btn-primary w-full py-3 text-sm cursor-pointer font-semibold">
				{$t('lpd.connectWallet')}
			</button>
		</div>
	{/if}
</div>
