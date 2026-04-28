<script lang="ts">
	import { ethers } from 'ethers';
	import { t } from '$lib/i18n';
	import FixedOverlay from '$lib/FixedOverlay.svelte';

	let {
		outputMode = 'token',
		isSwapping = false,

		// Swap stepper
		swapStep = 0,
		withdrawStep = 0,

		// Token details
		amountIn = '',
		amountOut = '',
		tokenInSymbol = '',
		tokenOutSymbol = '',
		tokenInIsNative = false,
		tokenInHasTax = false,
		tokenInTaxSell = 0,
		tokenOutHasTax = false,
		tokenOutTaxBuy = 0,
		displayAmountOut = '',

		// Trade details
		rate = '',
		minReceived = '',
		slippageBps = 50,
		usdValueOut = '',

		// Bank mode
		fiatEquivalent = '',
		previewFee = 0n,
		previewNet = 0n,
		usdtDecimals = 18,
		ngnRate = 0,
		paymentMethod = 'bank',
		bankBankName = '',
		bankResolved = false,
		bankName = '',
		paypalEmail = '',
		wiseEmail = '',
		payoutTimeoutMins = 0,
		payoutTimeoutLoaded = false,

		// Callbacks
		onClose,
		onConfirm,
		onDone,
	}: {
		outputMode?: 'token' | 'bank';
		isSwapping?: boolean;
		swapStep?: number;
		withdrawStep?: number;
		amountIn?: string;
		amountOut?: string;
		tokenInSymbol?: string;
		tokenOutSymbol?: string;
		tokenInIsNative?: boolean;
		tokenInHasTax?: boolean;
		tokenInTaxSell?: number;
		tokenOutHasTax?: boolean;
		tokenOutTaxBuy?: number;
		displayAmountOut?: string;
		rate?: string;
		minReceived?: string;
		slippageBps?: number;
		usdValueOut?: string;
		fiatEquivalent?: string;
		previewFee?: bigint;
		previewNet?: bigint;
		usdtDecimals?: number;
		ngnRate?: number;
		paymentMethod?: 'bank' | 'paypal' | 'wise';
		bankBankName?: string;
		bankResolved?: boolean;
		bankName?: string;
		paypalEmail?: string;
		wiseEmail?: string;
		payoutTimeoutMins?: number;
		payoutTimeoutLoaded?: boolean;
		onClose: () => void;
		onConfirm: () => void;
		onDone: () => void;
	} = $props();

	const swapBtnBase = "w-[calc(100%-8px)] my-2 mx-1 py-4 px-0 rounded-2xl border-0 cursor-pointer text-white font-[Syne,sans-serif] text-15 font-bold transition-all duration-200 tracking-[0.02em] hover:not-disabled:-translate-y-px disabled:opacity-85 disabled:cursor-not-allowed";
	const swapBtnTokenGrad = "bg-[linear-gradient(135deg,#00d2ff,#3a7bd5)] hover:not-disabled:shadow-[0_6px_28px_rgba(0,210,255,0.3)]";
	const swapBtnBankGrad = "bg-[linear-gradient(135deg,#10b981,#059669)] hover:not-disabled:shadow-[0_6px_28px_rgba(16,185,129,0.3)]";
</script>

<FixedOverlay show={true} onclose={() => { if (!isSwapping) onClose(); }}>
	<div class="w-full bg-(--bg) border border-(--border) rounded-[20px] overflow-hidden max-h-[80vh] max-sm:h-[80vh] max-sm:max-h-[80vh] max-sm:rounded-b-none flex flex-col">
		<div class="flex justify-between items-center px-5 py-4 border-b border-(--border)">
			<h3 class="font-[Syne,sans-serif] text-base font-bold text-(--text-heading) m-0">{outputMode === 'bank' ? $t('trade.confirmWithdrawal') : $t('trade.confirmSwap')}</h3>
			{#if !isSwapping}
				<button aria-label={$t('common.close')} class="bg-none border-0 text-(--text-muted) cursor-pointer p-1 rounded-lg transition-all duration-150 hover:text-(--text) hover:bg-(--bg-surface-hover)" onclick={onClose}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			{/if}
		</div>

		<div class="px-4 pt-3.5 pb-4 overflow-y-auto flex-1">
			{#if isSwapping}
				<!-- ═══ STEPPER (replaces review) ═══ -->
				{#if outputMode === 'bank' && withdrawStep > 0}
					{#if withdrawStep >= 5}
						<div class="text-center pt-4 pb-2">
							<div class="w-14 h-14 rounded-full mx-auto mb-3 flex items-center justify-center bg-[rgba(16,185,129,0.1)] border-2 border-[rgba(16,185,129,0.3)] animate-scale-in">
								<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
							</div>
							<span class="block font-[Syne,sans-serif] text-lg font-bold text-[#10b981] mb-1">{$t('trade.withdrawalSubmitted')}</span>
							<span class="block font-mono text-xs text-(--text-muted)">{$t('trade.withdrawalSubmittedDesc')}</span>
							<button class={swapBtnBase + " " + swapBtnBankGrad + " mx-0 mt-3 mb-0 w-full"} onclick={onDone}>
								{$t('trade.viewStatus')}
							</button>
						</div>
					{:else}
						<div class="pt-1 pb-3">
							<span class="font-[Rajdhani,sans-serif] text-lg font-bold text-(--text-heading) tabular-nums">{amountIn} {tokenInSymbol}</span>
							{#if fiatEquivalent}
								<span class="font-mono text-sm text-[#10b981] font-semibold ml-2">→ {fiatEquivalent}</span>
							{/if}
						</div>
						<div class="flex flex-col gap-0 mt-1 mb-3">
							{#each [
								{ n: 1, title: $t('trade.saveDetails'), desc: $t('trade.savingPaymentInfo'), activeDesc: $t('trade.savingDetails') },
								{ n: 2, title: $t('trade.approveToken'), desc: tokenInIsNative ? $t('trade.skippedForNative') : $t('trade.allowToken').replace('{symbol}', tokenInSymbol), activeDesc: tokenInIsNative ? $t('trade.skipping') : $t('trade.confirmInWallet') },
								{ n: 3, title: $t('trade.executeTrade'), desc: $t('trade.depositToContract'), activeDesc: $t('trade.confirmInWallet') }
							] as step}
								{@const isDone = withdrawStep > step.n}
								{@const isActive = withdrawStep === step.n}
								{@const isPending = withdrawStep < step.n}
								<div class={"flex items-center gap-3 px-3.5 py-3 border-l-2 relative transition-all duration-300 " + (isDone ? "border-l-[#10b981]" : isActive ? "border-l-[#00d2ff] bg-[rgba(0,210,255,0.03)]" : "border-l-(--border)")}>
									<div class={"w-7 h-7 rounded-full shrink-0 flex items-center justify-center border-2 font-mono text-xs2 font-bold transition-all duration-300 " + (isDone ? "border-[#10b981] bg-[rgba(16,185,129,0.15)] text-[#10b981]" : isActive ? "border-[#00d2ff] bg-[rgba(0,210,255,0.1)] text-[#00d2ff]" : "border-(--border) bg-(--bg-surface) text-(--text-dim)")}>
										{#if isDone}
											<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
										{:else if isActive}
											<div class="w-3.5 h-3.5 border-2 border-[rgba(0,210,255,0.2)] border-t-[#00d2ff] rounded-full animate-spin"></div>
										{:else}
											<span>{step.n}</span>
										{/if}
									</div>
									<div class="flex-1 min-w-0">
										<span class={"block font-mono text-xs font-bold " + (isPending ? "text-(--text-dim)" : isDone ? "text-[#10b981]" : isActive ? "text-[#00d2ff]" : "text-(--text-heading)")}>{step.title}</span>
										<span class={"block font-mono text-3xs mt-px " + (isActive ? "text-[rgba(0,210,255,0.7)]" : "text-(--text-muted)")}>{isActive ? step.activeDesc : step.desc}</span>
									</div>
									{#if isDone}
										<span class="font-mono text-3xs font-bold text-[#10b981] shrink-0">{$t('trade.done')}</span>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				{:else if outputMode === 'token'}
					{#if swapStep >= 3}
						<div class="text-center pt-4 pb-2">
							<div class="w-14 h-14 rounded-full mx-auto mb-3 flex items-center justify-center bg-[rgba(16,185,129,0.1)] border-2 border-[rgba(16,185,129,0.3)] animate-scale-in">
								<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
							</div>
							<span class="block font-[Syne,sans-serif] text-lg font-bold text-[#10b981] mb-1">{$t('trade.swapComplete')}</span>
							<span class="block font-mono text-xs text-(--text-muted)">{tokenInSymbol} → {tokenOutSymbol}</span>
							<button class={swapBtnBase + " " + swapBtnTokenGrad + " mx-0 mt-3 mb-0 w-full"} onclick={onDone}>
								{$t('trade.done')}
							</button>
						</div>
					{:else}
						<div class="flex flex-col gap-0 mt-1 mb-3">
							{#each [
								{ n: 1, title: $t('trade.approveToken'), desc: tokenInIsNative ? $t('trade.skippedForNative') : $t('trade.allowToken').replace('{symbol}', tokenInSymbol), activeDesc: tokenInIsNative ? $t('trade.skipping') : $t('trade.confirmInWallet') },
								{ n: 2, title: $t('trade.executeSwap'), desc: $t('trade.tradeArrow').replace('{symbolIn}', tokenInSymbol).replace('{symbolOut}', tokenOutSymbol), activeDesc: $t('trade.confirmInWallet') }
							] as step}
								{@const isDone = swapStep > step.n}
								{@const isActive = swapStep === step.n}
								{@const isPending = swapStep < step.n}
								<div class={"flex items-center gap-3 px-3.5 py-3 border-l-2 relative transition-all duration-300 " + (isDone ? "border-l-[#10b981]" : isActive ? "border-l-[#00d2ff] bg-[rgba(0,210,255,0.03)]" : "border-l-(--border)")}>
									<div class={"w-7 h-7 rounded-full shrink-0 flex items-center justify-center border-2 font-mono text-xs2 font-bold transition-all duration-300 " + (isDone ? "border-[#10b981] bg-[rgba(16,185,129,0.15)] text-[#10b981]" : isActive ? "border-[#00d2ff] bg-[rgba(0,210,255,0.1)] text-[#00d2ff]" : "border-(--border) bg-(--bg-surface) text-(--text-dim)")}>
										{#if isDone}
											<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
										{:else if isActive}
											<div class="w-3.5 h-3.5 border-2 border-[rgba(0,210,255,0.2)] border-t-[#00d2ff] rounded-full animate-spin"></div>
										{:else}
											<span>{step.n}</span>
										{/if}
									</div>
									<div class="flex-1 min-w-0">
										<span class={"block font-mono text-xs font-bold " + (isPending ? "text-(--text-dim)" : isDone ? "text-[#10b981]" : isActive ? "text-[#00d2ff]" : "text-(--text-heading)")}>{step.title}</span>
										<span class={"block font-mono text-3xs mt-px " + (isActive ? "text-[rgba(0,210,255,0.7)]" : "text-(--text-muted)")}>{isActive ? step.activeDesc : step.desc}</span>
									</div>
									{#if isDone}
										<span class="font-mono text-3xs font-bold text-[#10b981] shrink-0">{$t('trade.done')}</span>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				{/if}
			{:else}
			<!-- ═══ REVIEW (before clicking confirm) ═══ -->
			<div class="flex flex-col bg-(--bg-surface-input) rounded-xl overflow-hidden">
				<div class="px-3.5 py-2.5">
					<span class="block font-mono text-xs4 font-semibold uppercase tracking-[0.05em] text-(--text-muted) mb-0.5">{$t('trade.pay')}</span>
					<span class="block font-[Rajdhani,sans-serif] text-22 font-bold text-(--text-heading) leading-[1.3] tabular-nums">{amountIn} <span class="text-sm text-(--text-muted) font-semibold">{tokenInSymbol}</span></span>
					{#if tokenInHasTax}<span class="inline-block mt-[3px] font-mono text-xs4 text-[#f59e0b] bg-[rgba(245,158,11,0.08)] px-1.5 py-px rounded-[3px]">-{tokenInTaxSell / 100}% tax</span>{/if}
				</div>
				<div class="w-7 h-7 rounded-full bg-(--bg) border border-(--border) flex items-center justify-center text-(--text-dim) -my-3.5 mx-auto z-[1]">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14m0 0l-4-4m4 4l4-4"/></svg>
				</div>
				<div class="px-3.5 py-2.5 border-t border-(--border)">
					{#if outputMode === 'token'}
						<span class="block font-mono text-xs4 font-semibold uppercase tracking-[0.05em] text-(--text-muted) mb-0.5">{$t('trade.receive')}</span>
						<span class="block font-[Rajdhani,sans-serif] text-22 font-bold text-(--text-heading) leading-[1.3] tabular-nums">{displayAmountOut || '0'} <span class="text-sm text-(--text-muted) font-semibold">{tokenOutSymbol}</span></span>
						{#if tokenOutHasTax}<span class="inline-block mt-[3px] font-mono text-xs4 text-[#f59e0b] bg-[rgba(245,158,11,0.08)] px-1.5 py-px rounded-[3px]">-{tokenOutTaxBuy / 100}% tax</span>{/if}
					{:else}
						<span class="block font-mono text-xs4 font-semibold uppercase tracking-[0.05em] text-(--text-muted) mb-0.5">{$t('trade.to')}</span>
						<span class="block font-[Syne,sans-serif] text-13 font-bold text-(--text-heading) leading-[1.3]">{paymentMethod === 'bank' ? bankBankName : paymentMethod === 'paypal' ? 'PayPal' : 'Wise'}</span>
						{#if paymentMethod === 'bank' && bankResolved}
							<span class="block font-mono text-3xs text-[#10b981] font-semibold mt-0.5">{bankName}</span>
						{:else if paymentMethod === 'paypal'}
							<span class="block font-mono text-3xs text-[#10b981] font-semibold mt-0.5">{paypalEmail}</span>
						{:else if paymentMethod === 'wise'}
							<span class="block font-mono text-3xs text-[#10b981] font-semibold mt-0.5">{wiseEmail}</span>
						{/if}
					{/if}
				</div>
			</div>

			<div class="my-2.5 mb-3 px-3 py-2.5 border border-(--border) rounded-[10px]">
				{#if outputMode === 'token' && rate}
					{@const confirmMinUsd = usdValueOut && displayAmountOut && parseFloat(displayAmountOut) > 0
						? (parseFloat(usdValueOut.replace(/[^0-9.]/g, '')) * parseFloat(minReceived) / parseFloat(displayAmountOut)).toFixed(2)
						: ''}
					<div class="flex justify-between py-[3px] font-mono text-3xs [&>span:first-child]:text-(--text-muted) [&>span:last-child]:text-(--text)"><span>{$t('trade.rate')}</span><span>1 {tokenInSymbol} = {rate}</span></div>
					<div class="flex justify-between py-[3px] font-mono text-3xs [&>span:first-child]:text-(--text-muted) [&>span:last-child]:text-(--text)"><span>{$t('trade.minReceived')}</span><span>{minReceived} {tokenOutSymbol}{#if confirmMinUsd} <span class="text-(--text-muted) text-3xs font-[Rajdhani,sans-serif] font-medium tabular-nums">(≈${confirmMinUsd})</span>{/if}</span></div>
					<div class="flex justify-between py-[3px] font-mono text-3xs [&>span:first-child]:text-(--text-muted) [&>span:last-child]:text-(--text)"><span>{$t('trade.slippage')}</span><span>{(slippageBps / 100).toFixed(slippageBps % 100 === 0 ? 0 : slippageBps % 10 === 0 ? 1 : 2)}%</span></div>
					{#if tokenInTaxSell > 0}<div class="flex justify-between py-[3px] font-mono text-3xs [&>span:first-child]:text-(--text-muted) [&>span:last-child]:text-[#f59e0b]"><span>{$t('trade.sellTax')} ({tokenInSymbol})</span><span>{(tokenInTaxSell / 100).toFixed(1)}%</span></div>{/if}
					{#if tokenOutTaxBuy > 0}<div class="flex justify-between py-[3px] font-mono text-3xs [&>span:first-child]:text-(--text-muted) [&>span:last-child]:text-[#f59e0b]"><span>{$t('trade.buyTax')} ({tokenOutSymbol})</span><span>{(tokenOutTaxBuy / 100).toFixed(1)}%</span></div>{/if}
				{:else if outputMode === 'bank'}
					{#if previewFee > 0n}
						<div class="flex justify-between py-[3px] font-mono text-3xs [&>span:first-child]:text-(--text-muted) [&>span:last-child]:text-(--text)"><span>{$t('trade.feeWithPct').replace('{pct}', ((Number(previewFee) / Number(previewFee + previewNet)) * 100).toFixed(1))}</span><span>${parseFloat(ethers.formatUnits(previewFee, usdtDecimals)).toFixed(2)}</span></div>
						<div class="flex justify-between py-[3px] font-mono text-3xs [&>span:first-child]:text-(--text-muted) [&>span:last-child]:text-(--text)"><span>{$t('trade.netAmount')}</span><span>${parseFloat(ethers.formatUnits(previewNet, usdtDecimals)).toFixed(2)}</span></div>
					{/if}
					{#if fiatEquivalent}
						<div class="flex justify-between py-1.5 font-mono text-3xs [&>span:first-child]:text-(--text-muted)"><span>{$t('trade.youReceive')}</span><span class="font-[Rajdhani,sans-serif] text-base font-bold text-[#10b981] tabular-nums">{fiatEquivalent}</span></div>
						{#if ngnRate > 0}<div class="flex justify-between py-[3px] font-mono text-3xs [&>span:first-child]:text-(--text-muted) [&>span:last-child]:text-(--text)"><span>{$t('trade.rate')}</span><span>1 USD = ₦{ngnRate.toFixed(2)}</span></div>{/if}
					{/if}
					{#if payoutTimeoutLoaded}<div class="flex justify-between py-[3px] font-mono text-3xs [&>span:first-child]:text-(--text-muted) [&>span:last-child]:text-(--text)"><span>{$t('trade.processingLabel')}</span><span>{$t('trade.processingTime').replace('{min}', String(payoutTimeoutMins))}</span></div>{/if}
					<div class="flex justify-between py-[3px] font-mono text-3xs [&>span:first-child]:text-(--text-muted) [&>span:last-child]:text-[#10b981] [&>span:last-child]:text-3xs">
						<span>{$t('trade.escrow')}</span>
						<span>{$t('trade.escrowHeldBySc')}</span>
					</div>
				{/if}
			</div>

			<button
				class={swapBtnBase + " " + (outputMode === 'bank' ? swapBtnBankGrad : swapBtnTokenGrad) + " m-0 w-full"}
				onclick={onConfirm}
			>
				{outputMode === 'bank' ? $t('trade.confirmWithdrawal') : $t('trade.confirmSwap')}
			</button>
			{/if}
		</div>
	</div>
</FixedOverlay>
