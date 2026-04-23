<script lang="ts">
	import FixedOverlay from '$lib/FixedOverlay.svelte';
	import Badge from '$lib/Badge.svelte';
	import { t } from '$lib/i18n';
	import FeeReceipt from './FeeReceipt.svelte';
	import DeployProgressStepper from './DeployProgressStepper.svelte';
	import DepositInfo from './DepositInfo.svelte';
	import SuccessScreen from './SuccessScreen.svelte';
	import PaymentMethodSelector from './PaymentMethodSelector.svelte';

	type ReviewState = 'review' | 'progress' | 'deposit' | 'success';

	type TokenInfo = {
		name: string;
		symbol: string;
		totalSupply?: string;
		decimals?: number;
		isMintable?: boolean;
		isTaxable?: boolean;
		isPartner?: boolean;
		existingTokenAddress?: string;
		network: { name: string; chain_id?: number; explorer_url?: string };
		launch?: { enabled?: boolean; hardCap?: string; maxBuyBps?: string; minBuyUsdt?: string } | null;
		listing?: { enabled?: boolean; pairs?: Array<{ base: string; amount: string }> } | null;
	};

	type FeeRow = { label: string; amount: string; note?: boolean };
	type FeeDisplay = {
		fees: FeeRow[];
		total: string;
		warnings?: string[];
		hint?: string | null;
		loading?: boolean;
	};

	type DeployStep = {
		label: string;
		status: 'done' | 'active' | 'pending' | 'error' | 'skipped';
	};

	type PaymentOption = {
		address: string;
		symbol: string;
		name: string;
		balanceDisplay?: string;
		quoteDisplay?: string;
		logoUrl?: string | null;
	};

	type Deposit = {
		address: string;
		amountDisplay: string;
		balance: string | null;
		required: string | null;
	};

	type DeployResult = {
		tokenName: string;
		tokenSymbol: string;
		tokenAddress: string;
		txHash: string;
	};

	let {
		show = $bindable(false),
		state,
		tokenInfo,
		feeDisplay,
		deposit = null,
		deploySteps = [],
		deployTxHash = null,
		deployResult = null,
		paymentTokens = [],
		selectedPayment = null,
		selectedPaymentAmountDisplay = '',
		paymentLoading = false,
		paymentImportBusy = false,
		paymentImportError = null,
		showPaymentModal = $bindable(false),
		submitLabel = null,
		submitDisabled = false,
		onSubmit,
		onClose,
		onOpenPayment,
		onSelectPayment,
		onImportPayment,
		onManageTokens,
	}: {
		show: boolean;
		state: ReviewState;
		tokenInfo: TokenInfo | null;
		feeDisplay: FeeDisplay;
		deposit?: Deposit | null;
		deploySteps?: DeployStep[];
		deployTxHash?: string | null;
		deployResult?: DeployResult | null;
		paymentTokens?: PaymentOption[];
		selectedPayment?: PaymentOption | null;
		selectedPaymentAmountDisplay?: string;
		paymentLoading?: boolean;
		paymentImportBusy?: boolean;
		paymentImportError?: string | null;
		showPaymentModal: boolean;
		submitLabel?: string | null;
		submitDisabled?: boolean;
		onSubmit: () => void;
		onClose: () => void;
		onOpenPayment?: () => void;
		onSelectPayment?: (token: PaymentOption, index: number) => void;
		onImportPayment?: (address: string) => void;
		onManageTokens: () => void;
	} = $props();

	function explorerTxUrl(): string {
		if (!tokenInfo?.network?.explorer_url || !deployTxHash) return '#';
		const base = tokenInfo.network.explorer_url.replace(/\/$/, '');
		return base + '/tx/' + deployTxHash;
	}

	let defaultSubmitLabel = $derived.by(() => {
		if (!tokenInfo) return $t('ct.confirmDeploy');
		if (feeDisplay.loading) return $t('ct.calculatingFee');
		if (tokenInfo.existingTokenAddress) return 'Create Launch';
		if (tokenInfo.listing?.enabled) return $t('ct.deployAndList');
		if (tokenInfo.launch?.enabled) return 'Deploy & Launch';
		return $t('ct.confirmDeploy');
	});
</script>

<FixedOverlay bind:show onclose={onClose}>
	<div
		class="w-full sm:max-w-md h-[85vh] sm:h-auto sm:max-h-[90vh] overflow-y-auto bg-(--bg) border border-(--border-input) p-4 sm:p-6 rounded-t-[20px] sm:rounded-[20px] animate-slide-up sm:animate-modal-in [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden pb-[calc(1rem+env(safe-area-inset-bottom,0px))]"
	>
		<!-- Mobile drag indicator -->
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="sm:hidden flex justify-center pt-2 pb-1 cursor-pointer" onclick={onClose}>
			<div class="w-9 h-1 bg-(--border) rounded-[2px]"></div>
		</div>

		{#if state === 'success' && deployResult && tokenInfo}
			<SuccessScreen
				tokenName={deployResult.tokenName}
				tokenSymbol={deployResult.tokenSymbol}
				tokenAddress={deployResult.tokenAddress}
				txHash={deployResult.txHash}
				network={tokenInfo.network}
				title={tokenInfo.existingTokenAddress
					? 'Launch Created!'
					: tokenInfo.listing?.enabled
						? $t('ct.deployedListed')
						: tokenInfo.launch?.enabled
							? 'Token Deployed & Launched!'
							: $t('ct.deployed')}
				subtitle={$t('ct.liveOn') + ' ' + tokenInfo.network.name + '.' + (tokenInfo.listing?.enabled ? ' ' + $t('ct.liqAdded') : '')}
				{onManageTokens}
				{onClose}
			/>

		{:else if state === 'deposit' && deposit && tokenInfo}
			<div class="flex justify-between items-center mb-2">
				<h2 class="syne text-lg font-bold text-white">Deposit to Continue</h2>
				<button
					onclick={onClose}
					class="w-8 h-8 rounded-lg bg-(--bg-surface-hover) text-(--text-muted) border-none flex items-center justify-center text-sm cursor-pointer transition-all hover:text-(--text-heading)"
					aria-label="Close"
				>x</button>
			</div>

			<DepositInfo
				address={deposit.address}
				amountDisplay={deposit.amountDisplay}
				balance={deposit.balance}
				required={deposit.required}
				network={tokenInfo.network}
			/>

			<button onclick={onClose} class="btn-secondary text-sm py-2 cursor-pointer w-full mt-3">
				Cancel
			</button>

		{:else if state === 'progress'}
			<DeployProgressStepper
				steps={deploySteps}
				txHash={deployTxHash}
				txHref={deployTxHash ? explorerTxUrl() : null}
			/>

		{:else if state === 'review' && tokenInfo}
			<!-- Payment-focused review -->
			<div class="flex justify-between items-center mb-5">
				<h2 class="syne text-xl font-bold text-white">Confirm Payment</h2>
				<button
					onclick={onClose}
					class="w-8 h-8 rounded-lg bg-(--bg-surface-hover) text-(--text-muted) border-none flex items-center justify-center text-sm cursor-pointer transition-all hover:text-(--text-heading)"
					aria-label="Close"
				>x</button>
			</div>

			<!-- Token identifier (one line) -->
			<div class="flex items-baseline gap-2 mb-1">
				<span class="syne text-[15px] font-bold text-(--text-heading)">{tokenInfo.name} ({tokenInfo.symbol})</span>
				<span class="text-3xs text-cyan-400 font-mono">{tokenInfo.network.name}</span>
			</div>
			<div class="flex gap-1 flex-wrap mb-3">
				{#if tokenInfo.isMintable}<Badge variant="cyan">Mintable</Badge>{/if}
				{#if tokenInfo.isTaxable}<Badge variant="amber">Taxable</Badge>{/if}
				{#if tokenInfo.isPartner}<Badge variant="purple">Partner</Badge>{/if}
				{#if tokenInfo.listing?.enabled}<Badge variant="emerald">DEX Listing</Badge>{/if}
				{#if tokenInfo.launch?.enabled}<Badge variant="emerald">Launch</Badge>{/if}
				{#if !tokenInfo.isMintable && !tokenInfo.isTaxable && !tokenInfo.isPartner && !tokenInfo.listing?.enabled && !tokenInfo.launch?.enabled}
					<Badge variant="emerald">Standard</Badge>
				{/if}
			</div>

			<!-- Cost Breakdown -->
			<div class="mb-4 pb-4">
				<FeeReceipt
					fees={feeDisplay.fees}
					total={feeDisplay.total}
					hint={feeDisplay.hint ?? "Fee is denominated in USDT. Pay with any token — it's auto-converted."}
				/>

				{#if !feeDisplay.loading && paymentTokens.length > 0}
					<div class="flex flex-col gap-1.5 mt-3">
						<span class="text-4xs text-(--text-dim) font-mono uppercase tracking-[0.04em]">Pay with</span>
						<button
							class="flex items-center gap-2.5 w-full py-2.5 px-3 rounded-[10px] bg-(--bg-surface) border border-(--border) cursor-pointer transition-colors text-left hover:border-cyan-400/20"
							onclick={onOpenPayment}
						>
							{#if selectedPayment?.logoUrl}
								<img src={selectedPayment.logoUrl} alt={selectedPayment.symbol} class="w-8 h-8 rounded-full object-cover shrink-0" />
							{:else}
								<span class="w-8 h-8 rounded-full bg-cyan-400/[0.08] border border-cyan-400/15 flex items-center justify-center syne text-xs2 font-extrabold text-cyan-400 shrink-0">
									{selectedPayment?.symbol?.charAt(0) || '?'}
								</span>
							{/if}
							<div class="flex-1 flex flex-col">
								<span class="block syne text-xs3 font-bold text-(--text-heading)">{selectedPayment?.symbol}</span>
								<span class="block font-['Rajdhani',sans-serif] text-xs2 text-(--text-dim) tabular-nums">{selectedPaymentAmountDisplay} {selectedPayment?.symbol}</span>
							</div>
							<svg class="text-(--text-dim) shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
						</button>
					</div>
				{/if}

				{#if feeDisplay.warnings && feeDisplay.warnings.length > 0}
					<div class="mt-2 flex flex-col gap-1.5">
						{#each feeDisplay.warnings as w}
							<div class="p-3 rounded-[10px] bg-amber-400/[0.08] border border-amber-400/[0.35] text-amber-200 text-sm leading-normal">
								{w}
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<button
				onclick={onSubmit}
				disabled={submitDisabled || feeDisplay.loading || paymentTokens.length === 0}
				class="w-full p-3.5 rounded-xl font-bold text-[15px] text-(--text-heading) border-none mt-2 cursor-pointer transition-all bg-gradient-to-br from-cyan-400 to-blue-500 syne hover:not-disabled:-translate-y-px hover:not-disabled:shadow-[0_8px_32px_rgba(0,210,255,0.3)] disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{submitLabel ?? defaultSubmitLabel}
			</button>
		{/if}
	</div>
</FixedOverlay>

<!-- Nested payment selector -->
<PaymentMethodSelector
	bind:show={showPaymentModal}
	tokens={paymentTokens}
	selectedAddress={selectedPayment?.address ?? ''}
	loading={paymentLoading}
	importBusy={paymentImportBusy}
	importError={paymentImportError}
	onSelect={(t, i) => onSelectPayment?.(t, i)}
	onImport={(addr) => onImportPayment?.(addr)}
	onClose={() => { showPaymentModal = false; }}
/>
