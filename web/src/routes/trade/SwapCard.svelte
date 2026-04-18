<script lang="ts">
	import type { TaxInfo } from '$lib/tradeLens';
	import { t } from '$lib/i18n';
	import TokenInput from './TokenInput.svelte';
	import FlipButton from './FlipButton.svelte';
	import PayoutPreviewCard from './PayoutPreviewCard.svelte';
	import BankSelectorButton from './BankSelectorButton.svelte';
	import BankAccountField from './BankAccountField.svelte';
	import BankResolveStatus from './BankResolveStatus.svelte';
	import TrustCard from './TrustCard.svelte';
	import TrustItem from './TrustItem.svelte';
	import SpotRatePreview from './SpotRatePreview.svelte';
	import TradeDetails from './TradeDetails.svelte';
	import DetailLine from './DetailLine.svelte';
	import NoLiquidityNotice from './NoLiquidityNotice.svelte';
	import SwapActionButton from './SwapActionButton.svelte';

	let {
		outputMode = 'token',

		tokenInSymbol = '',
		tokenInLogo = '',
		amountIn = $bindable(''),
		tokenInBalance = 0n,
		tokenInDecimals = 18,
		tokenInIsNative = false,
		tokenInHasTax = false,
		tokenInTaxBuy = 0,
		tokenInTaxSell = 0,
		tokenInTax = null,
		tokenInIsPlatform = false,
		usdValueIn = '',
		estimatedGasCost = 0n,

		tokenOutSymbol = '',
		tokenOutLogo = '',
		displayAmountOut = '',
		tokenOutBalance = 0n,
		tokenOutDecimals = 18,
		tokenOutIsNative = false,
		tokenOutHasTax = false,
		tokenOutTaxBuy = 0,
		tokenOutTaxSell = 0,
		tokenOutTax = null,
		tokenOutIsPlatform = false,
		usdValueOut = '',
		previewLoading = false,

		rate = '',
		spotRate = '',
		minReceived = '',
		slippageBps = 50,
		noLiquidity = false,

		buttonLabel = '',
		buttonDisabled = false,
		insufficientBalance = false,
		noGas = false,
		userAddress = '',

		fiatEquivalent = '',
		previewNet = 0n,
		previewFee = 0n,
		usdtDecimals = 18,
		bankBankName = '',
		bankAccount = $bindable(''),
		bankResolving = false,
		bankResolved = false,
		bankName = '',
		bankError = '',
		payoutTimeoutMins = 0,
		payoutTimeoutLoaded = false,
		selectedNetwork = null,

		onSelectTokenIn,
		onSelectTokenOut,
		onFlip,
		onAction,
		onSelectBank,
	}: {
		outputMode?: 'token' | 'bank';

		tokenInSymbol?: string;
		tokenInLogo?: string;
		amountIn?: string;
		tokenInBalance?: bigint;
		tokenInDecimals?: number;
		tokenInIsNative?: boolean;
		tokenInHasTax?: boolean;
		tokenInTaxBuy?: number;
		tokenInTaxSell?: number;
		tokenInTax?: TaxInfo | null;
		tokenInIsPlatform?: boolean;
		usdValueIn?: string;
		estimatedGasCost?: bigint;

		tokenOutSymbol?: string;
		tokenOutLogo?: string;
		displayAmountOut?: string;
		tokenOutBalance?: bigint;
		tokenOutDecimals?: number;
		tokenOutIsNative?: boolean;
		tokenOutHasTax?: boolean;
		tokenOutTaxBuy?: number;
		tokenOutTaxSell?: number;
		tokenOutTax?: TaxInfo | null;
		tokenOutIsPlatform?: boolean;
		usdValueOut?: string;
		previewLoading?: boolean;

		rate?: string;
		spotRate?: string;
		minReceived?: string;
		slippageBps?: number;
		noLiquidity?: boolean;

		buttonLabel?: string;
		buttonDisabled?: boolean;
		insufficientBalance?: boolean;
		noGas?: boolean;
		userAddress?: string | null;

		fiatEquivalent?: string;
		previewNet?: bigint;
		previewFee?: bigint;
		usdtDecimals?: number;
		bankBankName?: string;
		bankAccount?: string;
		bankResolving?: boolean;
		bankResolved?: boolean;
		bankName?: string;
		bankError?: string;
		payoutTimeoutMins?: number;
		payoutTimeoutLoaded?: boolean;
		selectedNetwork?: any;

		onSelectTokenIn: () => void;
		onSelectTokenOut: () => void;
		onFlip: () => void;
		onAction: () => void;
		onSelectBank: () => void;
	} = $props();

	let slippagePct = $derived((slippageBps / 100).toFixed(slippageBps % 100 === 0 ? 0 : slippageBps % 10 === 0 ? 1 : 2));
	let minUsd = $derived(
		usdValueOut && displayAmountOut && parseFloat(displayAmountOut) > 0 && minReceived
			? (parseFloat(usdValueOut.replace(/[^0-9.]/g, '')) * parseFloat(minReceived) / parseFloat(displayAmountOut)).toFixed(2)
			: ''
	);

	let buttonVariant = $derived<'primary' | 'bank' | 'error'>(
		insufficientBalance || noGas ? 'error' : outputMode === 'bank' ? 'bank' : 'primary'
	);
	let contractUrl = $derived(
		selectedNetwork?.trade_router_address
			? `${selectedNetwork.explorer_url || 'https://bscscan.com'}/address/${selectedNetwork.trade_router_address}`
			: ''
	);
</script>

<div class="bg-(--bg-surface) border border-(--border) rounded-[20px] p-1 pb-3">

	<TokenInput
		label={$t('trade.youPay')}
		tokenSymbol={tokenInSymbol}
		tokenLogo={tokenInLogo}
		bind:amount={amountIn}
		balance={tokenInBalance}
		decimals={tokenInDecimals}
		isNative={tokenInIsNative}
		hasTax={tokenInHasTax}
		taxBuy={tokenInTaxBuy}
		taxSell={tokenInTaxSell}
		taxInfo={tokenInTax}
		isPlatform={tokenInIsPlatform}
		usdValue={usdValueIn}
		{estimatedGasCost}
		onSelectToken={onSelectTokenIn}
	/>

	{#if outputMode === 'token'}
		<FlipButton onclick={onFlip} />

		<TokenInput
			label={$t('trade.youReceive')}
			tokenSymbol={tokenOutSymbol}
			tokenLogo={tokenOutLogo}
			amount={displayAmountOut}
			readonly
			balance={tokenOutBalance}
			decimals={tokenOutDecimals}
			isNative={tokenOutIsNative}
			hasTax={tokenOutHasTax}
			taxBuy={tokenOutTaxBuy}
			taxSell={tokenOutTaxSell}
			taxInfo={tokenOutTax}
			isPlatform={tokenOutIsPlatform}
			usdValue={usdValueOut}
			{previewLoading}
			onSelectToken={onSelectTokenOut}
		/>

		{#if spotRate}
			<SpotRatePreview text={spotRate} />
		{/if}

		{#if rate}
			<TradeDetails>
				<DetailLine label={$t('trade.rate')}>1 {tokenInSymbol} = {rate} {tokenOutSymbol}</DetailLine>
				{#if minReceived}
					<DetailLine label={$t('trade.minReceived')}>
						{minReceived} {tokenOutSymbol}{#if minUsd} <span class="text-(--text-muted) text-xs font-[Rajdhani,sans-serif] font-medium tabular-nums">(≈${minUsd})</span>{/if}
					</DetailLine>
				{/if}
				<DetailLine label={$t('trade.slippage')}>{slippagePct}%</DetailLine>
				{#if tokenInTaxSell > 0}
					<DetailLine label="{$t('trade.sellTax')} ({tokenInSymbol})" warn>{(tokenInTaxSell / 100).toFixed(1)}%</DetailLine>
				{/if}
				{#if tokenOutTaxBuy > 0}
					<DetailLine label="{$t('trade.buyTax')} ({tokenOutSymbol})" warn>{(tokenOutTaxBuy / 100).toFixed(1)}%</DetailLine>
				{/if}
			</TradeDetails>
		{/if}

		{#if noLiquidity}
			<NoLiquidityNotice />
		{/if}
	{/if}

	{#if outputMode === 'bank'}
		<PayoutPreviewCard {fiatEquivalent} {previewFee} {previewNet} {usdtDecimals} />

		<div class="flex flex-col gap-2.5 mb-2 px-0.5">
			<div class="flex flex-col">
				<span class="font-mono text-xs2 font-semibold uppercase tracking-[0.05em] text-(--text-muted) mb-1">{$t('trade.bank')}</span>
				<BankSelectorButton bankName={bankBankName} onclick={onSelectBank} />
			</div>
			<BankAccountField bind:value={bankAccount} />
			<BankResolveStatus resolving={bankResolving} resolved={bankResolved} {bankName} error={bankError} />
		</div>

		<TrustCard title={$t('trade.onChainEscrow')} {contractUrl}>
			<TrustItem>{$t('trade.heldInSmartContract')}</TrustItem>
			<TrustItem>
				{#if payoutTimeoutLoaded}{$t('trade.autoRefundAfter').replace('{min}', String(payoutTimeoutMins))}{:else}{$t('trade.autoRefundIfFails')}{/if}
			</TrustItem>
			<TrustItem>{$t('trade.cancelBeforeConfirmation')}</TrustItem>
			<TrustItem>{$t('trade.noKycRequired')}</TrustItem>
		</TrustCard>
	{/if}

	<SwapActionButton
		variant={buttonVariant}
		disabled={buttonDisabled && !!userAddress}
		onclick={onAction}
	>
		{buttonLabel}
	</SwapActionButton>
</div>
