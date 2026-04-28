<script lang="ts">
	/**
	 * OnrampPanel — self-contained on-ramp flow (NGN → USDT).
	 *
	 * Visual mirrors the off-ramp:
	 *  - Inline: NGN amount card, USDT preview card, Review button
	 *  - Review step lives in a popup modal (ConfirmModalShell) with the
	 *    locked breakdown + "Create payment" button
	 *  - After payment is created: the inline bank-details panel takes over
	 *
	 * State machine:
	 *   idle → quoting → quoted (modal) → signing → submitting →
	 *     awaiting_payment → payment_received → delivering → delivered
	 *   forks: expired | failed | cancelled
	 */
	import { onDestroy } from 'svelte';
	import { ethers } from 'ethers';
	import { getContext } from 'svelte';
	import {
		ONRAMP_DOMAIN,
		ONRAMP_TYPES,
		type BankDetails,
		type OnrampIntent,
		type OnrampQuote,
	} from '$lib/onramp/types';
	import {
		getOnrampRate,
		quoteOnramp,
		submitOnrampIntent,
		getOnrampStatus,
		cancelOnrampIntent,
	} from '$lib/onramp/client';
	import SuccessBurst from '$lib/SuccessBurst.svelte';
	import ConfirmModalShell from './ConfirmModalShell.svelte';
	import { t } from '$lib/i18n';

	type State =
		| 'idle'
		| 'quoting'
		| 'quoted'
		| 'signing'
		| 'submitting'
		| 'awaiting_payment'
		| 'payment_received'
		| 'delivering'
		| 'delivered'
		| 'expired'
		| 'failed'
		| 'cancelled';

	let {
		chainId = 56,
		receiver,
		initialNgn,
		onsuccess,
	}: {
		chainId?: number;
		receiver?: string;
		initialNgn?: number;
		onsuccess?: (txHash: string) => void;
	} = $props();

	let flow = $state<State>('idle');
	let amountNgn = $state(initialNgn && initialNgn > 0 ? initialNgn : 5000);
	let quote = $state<OnrampQuote | null>(null);
	let bankDetails = $state<BankDetails | null>(null);
	let errorMsg = $state('');
	let secondsLeft = $state(0);
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let countdownTimer: ReturnType<typeof setInterval> | null = null;
	let lastDeliveryTx = $state<string | null>(null);
	let burstTrigger = $state(false);

	// Cached display rate fetched once on mount so the live preview lights
	// up as soon as the user types. The locked rate the user actually
	// transacts at comes from /api/onramp/quote.
	let displayRateX100 = $state<number | null>(null);
	let rateLoading = $state(true);

	const PRESET_AMOUNTS = [2000, 5000, 10000, 20000, 50000];

	const getSigner = getContext<() => ethers.Signer | null>('signer');
	const getUserAddress = getContext<() => string | null>('userAddress');
	const connectWallet = getContext<() => Promise<boolean>>('connectWallet');

	let signer = $derived(getSigner?.() ?? null);
	let userAddress = $derived(getUserAddress?.() ?? null);
	let effectiveReceiver = $derived(receiver ?? userAddress ?? '');

	// Modal visibility — every stage past "idle" lives in the popup modal,
	// so the inline panel only shows the amount input. The modal closes
	// on success (or via X / Cancel), bringing the user back to idle.
	let showReviewModal = $derived(flow !== 'idle');
	// Modal title flips with the flow stage so the user knows where they are.
	let modalTitle = $derived(
		flow === 'awaiting_payment' || flow === 'payment_received' || flow === 'delivering'
			? 'Make payment'
			: flow === 'delivered'
				? 'Delivered'
				: flow === 'expired'
					? 'Quote expired'
					: flow === 'failed'
						? 'Payment failed'
						: flow === 'cancelled'
							? 'Cancelled'
							: 'Confirm payment',
	);
	// Hard-lock close while a tx is mid-flight so partial state isn't dropped.
	let modalClosable = $derived(flow !== 'signing' && flow !== 'submitting');

	// Pre-fetch display rate once.
	getOnrampRate(chainId)
		.then((r) => {
			displayRateX100 = r.rate_x100;
		})
		.catch(() => {})
		.finally(() => {
			rateLoading = false;
		});

	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
		if (countdownTimer) clearInterval(countdownTimer);
	});

	let livePreviewUsdt = $derived(
		displayRateX100 && amountNgn > 0
			? Number((BigInt(Math.round(amountNgn * 100)) * 10000n) / BigInt(displayRateX100)) / 10000
			: null,
	);
	let liveRate = $derived(displayRateX100 ? displayRateX100 / 100 : null);

	let usdtPreview = $derived(
		quote ? Number((BigInt(quote.usdt_amount_wei) * 10000n) / 10n ** 18n) / 10000 : null,
	);
	let ratePreview = $derived(quote ? quote.rate_x100 / 100 : null);

	let buttonLabel = $derived(
		flow === 'quoting' ? 'Locking rate…' : amountNgn < 500 ? 'Enter at least ₦500' : 'Review details',
	);
	let buttonDisabled = $derived(!amountNgn || amountNgn < 500 || flow === 'quoting');

	async function handleReview() {
		if (buttonDisabled) return;
		errorMsg = '';
		flow = 'quoting';
		try {
			quote = await quoteOnramp(amountNgn, chainId);
			flow = 'quoted';
		} catch (e) {
			errorMsg = (e as Error).message;
			flow = 'idle';
		}
	}

	async function handleConfirm() {
		if (!quote) return;
		errorMsg = '';

		if (!signer || !userAddress) {
			try {
				await connectWallet?.();
			} catch {}
			if (!signer || !userAddress) {
				errorMsg = 'Connect your wallet to continue';
				return;
			}
		}

		flow = 'signing';
		const intent: OnrampIntent = {
			receiver: effectiveReceiver,
			chainId: quote.chain_id,
			ngnAmount: String(quote.ngn_amount_kobo),
			usdtAmount: quote.usdt_amount_wei,
			rate: String(quote.rate_x100),
			reference: quote.reference,
			nonce: quote.nonce,
			expiresAt: String(quote.expires_at),
		};

		let signature: string;
		try {
			signature = await (signer as ethers.Signer).signTypedData(
				ONRAMP_DOMAIN(quote.chain_id),
				ONRAMP_TYPES,
				intent,
			);
		} catch {
			errorMsg = 'Signature cancelled';
			flow = 'quoted';
			return;
		}

		flow = 'submitting';
		try {
			const res = await submitOnrampIntent(intent, signature);
			bankDetails = res.bank_details;
			flow = 'awaiting_payment';
			startPolling(res.reference);
			startCountdown();
		} catch (e) {
			errorMsg = (e as Error).message;
			flow = 'quoted';
		}
	}

	function dismissReview() {
		// Modal X / backdrop click while we're not mid-broadcast.
		if (flow === 'signing' || flow === 'submitting') return;
		quote = null;
		flow = 'idle';
		errorMsg = '';
	}

	function startPolling(reference: string) {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(async () => {
			try {
				const s = await getOnrampStatus(reference);
				if (s.status === 'payment_received') flow = 'payment_received';
				else if (s.status === 'delivering') flow = 'delivering';
				else if (s.status === 'delivered') {
					flow = 'delivered';
					lastDeliveryTx = s.delivery_tx_hash;
					burstTrigger = true;
					if (pollTimer) {
						clearInterval(pollTimer);
						pollTimer = null;
					}
					if (countdownTimer) {
						clearInterval(countdownTimer);
						countdownTimer = null;
					}
					try {
						onsuccess?.(s.delivery_tx_hash ?? '');
					} catch {}
				} else if (s.status === 'failed') {
					flow = 'failed';
					errorMsg = s.failure_reason ?? 'Payment failed';
					if (pollTimer) {
						clearInterval(pollTimer);
						pollTimer = null;
					}
				} else if (s.status === 'cancelled' || s.status === 'expired') {
					flow = s.status as State;
					if (pollTimer) {
						clearInterval(pollTimer);
						pollTimer = null;
					}
				}
			} catch {
				// Transient — try next tick.
			}
		}, 5000);
	}

	function startCountdown() {
		if (!quote) return;
		secondsLeft = Math.max(0, quote.expires_at - Math.floor(Date.now() / 1000));
		if (countdownTimer) clearInterval(countdownTimer);
		countdownTimer = setInterval(() => {
			if (!quote) return;
			secondsLeft = Math.max(0, quote.expires_at - Math.floor(Date.now() / 1000));
			if (secondsLeft <= 0) {
				if (flow === 'awaiting_payment') flow = 'expired';
				if (countdownTimer) {
					clearInterval(countdownTimer);
					countdownTimer = null;
				}
			}
		}, 1000);
	}

	async function handleCancel() {
		if (!quote) {
			reset();
			return;
		}
		try {
			await cancelOnrampIntent(quote.reference);
		} catch {}
		flow = 'cancelled';
		setTimeout(reset, 800);
	}

	function reset() {
		quote = null;
		bankDetails = null;
		flow = 'idle';
		errorMsg = '';
		secondsLeft = 0;
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		if (countdownTimer) {
			clearInterval(countdownTimer);
			countdownTimer = null;
		}
	}

	function copyText(s: string) {
		try {
			navigator.clipboard?.writeText(s);
		} catch {}
	}

	function fmtCountdown(s: number): string {
		const m = Math.floor(s / 60);
		const ss = (s % 60).toString().padStart(2, '0');
		return `${m}:${ss}`;
	}

	// Inline panel = just the amount input. Everything else lives in the modal.
</script>

<!-- ═══ INLINE INPUT (amount only) ═══ -->
	<!-- ═══ INLINE INPUT (matches off-ramp visual: card → preview → trust → button) ═══ -->
	<div class="flex flex-col bg-(--bg-surface-input) rounded-xl overflow-hidden">
		<div class="flex justify-between items-start px-3.5 pt-3 pb-1.5">
			<span class="font-mono text-xs4 font-semibold uppercase tracking-[0.05em] text-(--text-muted)">{$t('trade.youPay')}</span>
			<span class="font-mono text-3xs text-(--text-dim) tabular-nums">NGN</span>
		</div>
		<div class="px-3.5 pb-3 pt-1 flex items-baseline gap-2">
			<span class="font-numeric text-22 font-bold text-(--text-muted) shrink-0">₦</span>
			<input
				type="number"
				inputmode="numeric"
				min="500"
				max="50000"
				step="500"
				class="flex-1 bg-transparent border-0 outline-none font-numeric text-28 font-bold text-(--text-heading) leading-[1.2] tabular-nums w-full"
				bind:value={amountNgn}
				disabled={flow !== 'idle'}
			/>
		</div>
		<div class="flex flex-wrap gap-1.5 px-3.5 pb-3">
			{#each PRESET_AMOUNTS as preset}
				<button
					type="button"
					class={'px-2.5 py-1 rounded-md font-mono text-3xs border transition tabular-nums ' +
						(amountNgn === preset
							? 'bg-cyan-400/10 border-cyan-400/40 text-cyan-300'
							: 'bg-(--bg-surface) border-(--border) text-(--text-muted) hover:text-(--text-heading)')}
					onclick={() => (amountNgn = preset)}
					disabled={flow !== 'idle'}
				>
					₦{preset.toLocaleString()}
				</button>
			{/each}
		</div>
	</div>

	<!-- USDT preview (mirrors PayoutPreviewCard look) -->
	<div class="bg-[rgba(16,185,129,0.05)] border border-[rgba(16,185,129,0.1)] rounded-[10px] p-3.5 my-3 mb-2.5">
		<div class="text-center">
			{#if rateLoading}
				<span class="block font-mono text-xs2 text-(--text-dim)">Loading rate…</span>
			{:else if livePreviewUsdt !== null}
				<span class="block font-[Rajdhani,sans-serif] text-28 font-bold text-[#10b981] leading-[1.2] tabular-nums">{livePreviewUsdt.toFixed(4)} USDT</span>
				<span class="block font-mono text-3xs text-(--text-dim) mt-1">{$t('trade.youReceive')} (est.)</span>
			{:else}
				<span class="block font-mono text-xs2 text-(--text-dim)">—</span>
			{/if}
		</div>
		{#if liveRate !== null}
			<div class="flex flex-col gap-1 mt-2 pt-2 border-t border-(--border-subtle)">
				<div class="flex justify-between font-mono text-3xs text-(--text-dim)">
					<span>Rate</span>
					<span>₦{liveRate.toFixed(2)} / $1</span>
				</div>
			</div>
		{/if}
	</div>

	{#if errorMsg && flow === 'idle'}
		<p class="font-mono text-xs2 text-red-400 mt-3 m-0">{errorMsg}</p>
	{/if}

	<button
		class="w-full mt-3 py-3.5 rounded-2xl border-0 cursor-pointer text-white font-[Syne,sans-serif] text-15 font-bold transition-all duration-200 tracking-[0.02em] bg-[linear-gradient(135deg,#00d2ff,#3a7bd5)] hover:not-disabled:-translate-y-px hover:not-disabled:shadow-[0_6px_28px_rgba(0,210,255,0.3)] disabled:opacity-50 disabled:cursor-not-allowed"
		onclick={handleReview}
		disabled={buttonDisabled}
	>
		{buttonLabel}
	</button>

<!-- ═══ FLOW MODAL — every stage past idle lives here ═══ -->
{#if showReviewModal}
	<ConfirmModalShell title={modalTitle} closable={modalClosable} onClose={dismissReview}>
		{#if flow === 'quoting'}
			<div class="flex flex-col items-center gap-3 py-8">
				<div class="w-10 h-10 rounded-full border-2 border-cyan-400/30 border-t-cyan-400 animate-spin"></div>
				<p class="font-mono text-xs text-(--text-muted) m-0">Locking rate…</p>
			</div>
		{:else if flow === 'signing'}
			<div class="flex flex-col items-center gap-3 py-8">
				<div class="w-10 h-10 rounded-full border-2 border-cyan-400/30 border-t-cyan-400 animate-spin"></div>
				<p class="font-mono text-xs text-(--text-muted) text-center m-0">Sign in your wallet to bind the receiver address.</p>
			</div>
		{:else if flow === 'submitting'}
			<div class="flex flex-col items-center gap-3 py-8">
				<div class="w-10 h-10 rounded-full border-2 border-cyan-400/30 border-t-cyan-400 animate-spin"></div>
				<p class="font-mono text-xs text-(--text-muted) m-0">Generating your bank details…</p>
			</div>
		{:else if flow === 'quoted' && quote}
			<!-- Pay / Receive (mirrors ConfirmTradeModal layout) -->
			<div class="flex flex-col bg-(--bg-surface-input) rounded-xl overflow-hidden">
				<div class="px-3.5 py-2.5">
					<span class="block font-mono text-xs4 font-semibold uppercase tracking-[0.05em] text-(--text-muted) mb-0.5">Pay</span>
					<span class="block font-[Rajdhani,sans-serif] text-22 font-bold text-(--text-heading) leading-[1.3] tabular-nums">₦{(Number(quote.ngn_amount_kobo) / 100).toLocaleString()}</span>
				</div>
				<div class="relative h-px bg-(--border)">
					<div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-(--bg-surface) border border-(--border) flex items-center justify-center">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
					</div>
				</div>
				<div class="px-3.5 py-2.5">
					<span class="block font-mono text-xs4 font-semibold uppercase tracking-[0.05em] text-(--text-muted) mb-0.5">Receive</span>
					<span class="block font-[Rajdhani,sans-serif] text-22 font-bold text-[#10b981] leading-[1.3] tabular-nums">{usdtPreview?.toFixed(4)} <span class="text-sm text-(--text-muted) font-semibold">USDT</span></span>
				</div>
			</div>

			<div class="mt-3 px-3.5 py-3 rounded-xl bg-(--bg-surface) border border-(--border) flex flex-col gap-2">
				<div class="flex justify-between items-center">
					<span class="font-mono text-xs2 text-(--text-muted)">Locked rate</span>
					<span class="font-numeric text-xs2 text-(--text-heading) tabular-nums">₦{ratePreview?.toFixed(2)} / $1</span>
				</div>
				{#if quote.fee_bps > 0}
					<div class="flex justify-between items-center">
						<span class="font-mono text-xs2 text-(--text-muted)">Fee ({(quote.fee_bps / 100).toFixed(2)}%)</span>
						<span class="font-numeric text-xs2 text-(--text-muted) tabular-nums">−{((Number(BigInt(quote.usdt_gross_wei) - BigInt(quote.usdt_amount_wei)) / 1e18).toFixed(4))} USDT</span>
					</div>
				{/if}
				<div class="flex justify-between items-center">
					<span class="font-mono text-xs2 text-(--text-muted)">Receiver</span>
					<span class="font-mono text-xs2 text-(--text-heading)">{effectiveReceiver.slice(0, 6)}…{effectiveReceiver.slice(-4)}</span>
				</div>
				<div class="flex justify-between items-center">
					<span class="font-mono text-xs2 text-(--text-muted)">Quote valid for</span>
					<span class="font-numeric text-xs2 text-(--text-heading) tabular-nums">15 minutes</span>
				</div>
			</div>

			<p class="font-mono text-3xs text-(--text-dim) mt-2 mb-3 m-0 leading-relaxed">
				Signing binds USDT delivery to your wallet only — even a compromised backend can't redirect it. The locked rate stays in effect for 15 minutes after signing.
			</p>

			{#if errorMsg}
				<p class="font-mono text-xs2 text-red-400 mt-1 mb-2 m-0">{errorMsg}</p>
			{/if}

			<button
				class="w-full mt-1 py-3.5 rounded-2xl border-0 cursor-pointer text-white font-[Syne,sans-serif] text-15 font-bold transition-all duration-200 tracking-[0.02em] bg-[linear-gradient(135deg,#00d2ff,#3a7bd5)] hover:not-disabled:-translate-y-px hover:not-disabled:shadow-[0_6px_28px_rgba(0,210,255,0.3)]"
				onclick={handleConfirm}
			>
				Create payment
			</button>
		{:else if flow === 'awaiting_payment' && bankDetails}
			<!-- Bank details — VA created, waiting for the user's transfer -->
			<div class="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3 flex items-start gap-2 mb-3">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" class="shrink-0 mt-0.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
				<div class="flex-1 min-w-0">
					<p class="font-display text-xs font-bold text-amber-300 m-0">One-time use account — expires in {fmtCountdown(secondsLeft)}</p>
					<p class="font-mono text-3xs text-amber-200/80 mt-1 m-0 leading-relaxed">
						Send <span class="font-bold">exactly ₦{bankDetails.amount_ngn.toLocaleString()}</span> once. Any payment after expiry will be returned by your bank — do not reuse this account.
					</p>
				</div>
			</div>

			<div class="rounded-xl border border-cyan-400/15 bg-cyan-400/[0.04] p-4 flex flex-col gap-3">
				<div>
					<span class="block font-mono text-xs2 text-(--text-muted)">Send exactly</span>
					<span class="block font-numeric text-22 font-bold text-(--text-heading) tabular-nums">₦{bankDetails.amount_ngn.toLocaleString()}</span>
				</div>
				<div class="flex flex-col gap-2">
					<div class="px-3 py-2 rounded-[10px] bg-(--bg-surface) border border-(--border)">
						<span class="block font-mono text-3xs text-(--text-muted) uppercase tracking-wide">Bank</span>
						<span class="block font-display text-sm font-bold text-(--text-heading) truncate">{bankDetails.bank_name}</span>
					</div>
					<div class="flex items-center justify-between gap-2 px-3 py-2 rounded-[10px] bg-(--bg-surface) border border-(--border)">
						<div class="min-w-0">
							<span class="block font-mono text-3xs text-(--text-muted) uppercase tracking-wide">Account number</span>
							<span class="block font-numeric text-base font-bold text-(--text-heading) tabular-nums">{bankDetails.account_number}</span>
						</div>
						<button class="shrink-0 px-2.5 py-1 rounded-md bg-(--bg-surface-hover) border border-(--border) text-(--text-muted) font-mono text-3xs hover:text-cyan-300" onclick={() => copyText(bankDetails!.account_number)}>Copy</button>
					</div>
					<div class="px-3 py-2 rounded-[10px] bg-(--bg-surface) border border-(--border)">
						<span class="block font-mono text-3xs text-(--text-muted) uppercase tracking-wide">Account name</span>
						<span class="block font-display text-sm font-bold text-(--text-heading) truncate">{bankDetails.account_name}</span>
					</div>
					<div class="flex items-center justify-between gap-2 px-3 py-2 rounded-[10px] bg-(--bg-surface) border border-(--border)">
						<div class="min-w-0">
							<span class="block font-mono text-3xs text-(--text-muted) uppercase tracking-wide">Reference</span>
							<span class="block font-mono text-xs2 text-(--text-heading) truncate">{bankDetails.reference}</span>
						</div>
						<button class="shrink-0 px-2.5 py-1 rounded-md bg-(--bg-surface-hover) border border-(--border) text-(--text-muted) font-mono text-3xs hover:text-cyan-300" onclick={() => copyText(bankDetails!.reference)}>Copy</button>
					</div>
				</div>
				<p class="font-mono text-3xs text-(--text-dim) m-0 leading-relaxed">USDT lands in your wallet within 5 minutes after the bank confirms.</p>
			</div>

			<button class="w-full mt-3 py-2 rounded-lg bg-(--bg-surface) border border-(--border) text-(--text-muted) font-mono text-xs2 hover:text-red-400" onclick={handleCancel}>
				Cancel this payment
			</button>
		{:else if flow === 'payment_received' || flow === 'delivering'}
			<div class="flex flex-col items-center gap-3 py-10">
				<div class="w-10 h-10 rounded-full border-2 border-emerald-400/30 border-t-emerald-400 animate-spin"></div>
				<div class="text-center">
					<p class="font-display text-sm font-bold text-emerald-300 m-0">Payment received ✓</p>
					<p class="font-mono text-xs2 text-(--text-muted) mt-1 m-0">Sending USDT to your wallet…</p>
				</div>
			</div>
		{:else if flow === 'delivered'}
			<div class="flex flex-col items-center gap-3 py-8 relative">
				<SuccessBurst show={burstTrigger} onComplete={() => (burstTrigger = false)} />
				<p class="font-display text-base font-bold text-emerald-300 m-0">USDT in your wallet ✓</p>
				{#if lastDeliveryTx}
					<a href="https://bscscan.com/tx/{lastDeliveryTx}" target="_blank" rel="noopener" class="font-mono text-3xs text-cyan-300 hover:underline truncate max-w-full">{lastDeliveryTx.slice(0, 10)}…{lastDeliveryTx.slice(-8)}</a>
				{/if}
				<button class="mt-2 px-4 py-2 rounded-lg bg-(--bg-surface) border border-(--border) text-(--text-muted) syne text-xs font-bold" onclick={reset}>
					Buy more
				</button>
			</div>
		{:else if flow === 'expired'}
			<div class="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4 text-center">
				<p class="font-display text-sm font-bold text-amber-300 m-0">Quote expired</p>
				<p class="font-mono text-xs2 text-(--text-muted) mt-1 m-0">Get a fresh quote to continue.</p>
				<button class="mt-3 px-4 py-2 rounded-lg bg-[linear-gradient(135deg,#00d2ff,#3a7bd5)] text-white syne text-xs font-bold" onclick={reset}>
					New quote
				</button>
			</div>
		{:else if flow === 'failed'}
			<div class="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-4">
				<p class="font-display text-sm font-bold text-red-300 m-0">Payment failed</p>
				<p class="font-mono text-xs2 text-(--text-muted) mt-1 m-0">{errorMsg}</p>
				<button class="mt-3 px-4 py-2 rounded-lg bg-(--bg-surface) border border-(--border) text-(--text-muted) syne text-xs font-bold" onclick={reset}>
					Try again
				</button>
			</div>
		{:else if flow === 'cancelled'}
			<p class="font-mono text-xs text-(--text-muted) text-center py-8 m-0">Cancelled.</p>
		{/if}
	</ConfirmModalShell>
{/if}
