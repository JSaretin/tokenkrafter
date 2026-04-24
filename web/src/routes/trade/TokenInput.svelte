<script lang="ts">
	import { ethers } from 'ethers';
	import type { TaxInfo } from '$lib/tradeLens';
	import TokenSelectorButton from './TokenSelectorButton.svelte';
	import AmountInput from './AmountInput.svelte';
	import MaxButton from './MaxButton.svelte';
	import BalanceRow from './BalanceRow.svelte';
	import TokenTaxBadge from './TokenTaxBadge.svelte';

	let {
		label,
		tokenSymbol = '',
		tokenLogo = '',
		amount = $bindable(''),
		readonly = false,
		balance = 0n,
		decimals = 18,
		isNative = false,
		hasTax = false,
		taxBuy = 0,
		taxSell = 0,
		taxInfo = null,
		isPlatform = false,
		usdValue = '',
		previewLoading = false,
		estimatedGasCost = 0n,
		onSelectToken,
		onMaxClick,
	}: {
		label: string;
		tokenSymbol?: string;
		tokenLogo?: string;
		amount?: string;
		readonly?: boolean;
		balance?: bigint;
		decimals?: number;
		isNative?: boolean;
		hasTax?: boolean;
		taxBuy?: number;
		taxSell?: number;
		taxInfo?: TaxInfo | null;
		isPlatform?: boolean;
		usdValue?: string;
		previewLoading?: boolean;
		estimatedGasCost?: bigint;
		onSelectToken: () => void;
		onMaxClick?: () => void;
	} = $props();

	function handleMax() {
		if (onMaxClick) {
			onMaxClick();
			return;
		}
		let raw: string;
		if (isNative) {
			const gasBuffer = estimatedGasCost * 12n / 10n;
			const maxAmount = balance > gasBuffer ? balance - gasBuffer : 0n;
			raw = ethers.formatUnits(maxAmount, decimals);
		} else {
			raw = ethers.formatUnits(balance, decimals);
		}
		const dot = raw.indexOf('.');
		amount = dot === -1 ? raw : raw.slice(0, dot + 9);
	}
</script>

<div class={"bg-(--bg-surface-input) rounded-2xl py-3.5 px-4 " + (readonly ? "mt-1" : "")}>
	<div class="flex justify-between items-center mb-2">
		<span class="font-mono text-xs2 font-semibold text-(--text-muted) uppercase tracking-[0.05em]">{label}</span>
		<TokenSelectorButton symbol={tokenSymbol} logo={tokenLogo} onclick={onSelectToken} />
	</div>
	<div class="flex items-center gap-2 relative">
		<AmountInput bind:value={amount} {readonly} loading={previewLoading} />
		{#if !readonly && tokenSymbol && balance > 0n}
			<MaxButton onclick={handleMax} />
		{/if}
	</div>
	<BalanceRow symbol={tokenSymbol} {balance} {decimals} {usdValue} />
	<TokenTaxBadge {taxInfo} {taxBuy} {taxSell} {hasTax} {isNative} {isPlatform} />
</div>
