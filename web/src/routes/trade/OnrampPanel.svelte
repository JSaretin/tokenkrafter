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
		quoteOnramp,
		submitOnrampIntent,
		getOnrampStatus,
		cancelOnrampIntent,
	} from '$lib/onramp/client';
	import SuccessBurst from '$lib/SuccessBurst.svelte';
	import ConfirmModalShell from './ConfirmModalShell.svelte';
	import OnrampStatusModal from './OnrampStatusModal.svelte';
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
		/** SSR-supplied display rate (NGN per USD). Pass from the trade
		 *  page's load(); without it the live preview just shows "—" until
		 *  the user clicks Review (which fetches the locked rate anyway). */
		initialRate,
		/** Minimum on-ramp amount in whole NGN. SSR-supplied so the input's
		 *  validation matches the server's `onramp_min_kobo` config. */
		minNgn = 500,
		/** Bindable amount input — lives at the parent so it survives
		 *  tab switches (Buy → Swap → Buy keeps the typed amount). */
		amountNgn = $bindable<number | null>(null),
		onsuccess,
	}: {
		chainId?: number;
		receiver?: string;
		initialRate?: number | null;
		minNgn?: number;
		amountNgn?: number | null;
		onsuccess?: (txHash: string) => void;
	} = $props();

	let flow = $state<State>('idle');
	// amountNgn is a bindable prop (declared above) so its value lives
	// at the parent and survives tab switches.
	let quote = $state<OnrampQuote | null>(null);
	let bankDetails = $state<BankDetails | null>(null);
	let errorMsg = $state('');
	let secondsLeft = $state(0);
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let countdownTimer: ReturnType<typeof setInterval> | null = null;
	let lastDeliveryTx = $state<string | null>(null);
	let burstTrigger = $state(false);

	// Display rate seeded from SSR so the live preview lights up on first
	// paint — no client round-trip on tab switch. Locked rate at sign-time
	// still comes from /api/onramp/quote.
	let displayRateX100 = $state<number | null>(
		initialRate && initialRate > 0 ? Math.round(initialRate * 100) : null,
	);
	let rateLoading = $derived(displayRateX100 === null);

	const getSigner = getContext<() => ethers.Signer | null>('signer');
	const getUserAddress = getContext<() => string | null>('userAddress');
	const connectWallet = getContext<() => Promise<boolean>>('connectWallet');

	let signer = $derived(getSigner?.() ?? null);
	let userAddress = $derived(getUserAddress?.() ?? null);
	let effectiveReceiver = $derived(receiver ?? userAddress ?? '');

	// Pre-submit modal: review + sign + submit. After submit we hand off
	// to OnrampStatusModal (mounted below) so the look matches the
	// history-row modal.
	let showReviewModal = $derived(
		flow === 'quoting' || flow === 'quoted' || flow === 'signing' || flow === 'submitting',
	);
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

	// Stages from awaiting_payment onwards delegate to OnrampStatusModal so
	// the look matches the history-row modal exactly. Map our internal
	// `flow` to the onramp_intents status vocabulary the modal expects.
	let postSubmit = $derived(
		flow === 'awaiting_payment' ||
		flow === 'payment_received' ||
		flow === 'delivering' ||
		flow === 'delivered' ||
		flow === 'expired' ||
		flow === 'failed' ||
		flow === 'cancelled',
	);
	let postSubmitStatus = $derived(
		flow === 'awaiting_payment' ? 'pending_payment'
			: flow === 'payment_received' ? 'payment_received'
			: flow === 'delivering' ? 'delivering'
			: flow === 'delivered' ? 'delivered'
			: flow === 'expired' ? 'expired'
			: flow === 'failed' ? 'failed'
			: flow === 'cancelled' ? 'cancelled'
			: 'pending_payment',
	);
	let statusRow = $derived(
		quote
			? {
				reference: quote.reference,
				status: postSubmitStatus,
				chain_id: quote.chain_id,
				ngn_amount_kobo: quote.ngn_amount_kobo,
				usdt_amount_wei: quote.usdt_amount_wei,
				rate_x100: quote.rate_x100,
				expires_at: new Date(quote.expires_at * 1000).toISOString(),
				created_at: new Date().toISOString(),
				paid_at: null,
				delivered_at: flow === 'delivered' ? new Date().toISOString() : null,
				delivery_tx_hash: lastDeliveryTx,
				failure_reason: flow === 'failed' ? errorMsg || null : null,
				flutterwave_va_account_number: bankDetails?.account_number ?? null,
				flutterwave_va_bank_name: bankDetails?.bank_name ?? null,
			}
			: null,
	);

	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
		if (countdownTimer) clearInterval(countdownTimer);
	});

	let livePreviewUsdt = $derived(
		displayRateX100 && amountNgn != null && amountNgn > 0
			? Number((BigInt(Math.round(amountNgn * 100)) * 10000n) / BigInt(displayRateX100)) / 10000
			: null,
	);
	let liveRate = $derived(displayRateX100 ? displayRateX100 / 100 : null);

	let usdtPreview = $derived(
		quote ? Number((BigInt(quote.usdt_amount_wei) * 10000n) / 10n ** 18n) / 10000 : null,
	);
	let ratePreview = $derived(quote ? quote.rate_x100 / 100 : null);

	let buttonLabel = $derived(
		flow === 'quoting'
			? 'Locking rate…'
			: !amountNgn
				? `Enter at least ₦${minNgn.toLocaleString()}`
				: amountNgn < minNgn
					? `Minimum is ₦${minNgn.toLocaleString()}`
					: 'Review details',
	);
	let buttonDisabled = $derived(!amountNgn || amountNgn < minNgn || flow === 'quoting');

	async function handleReview() {
		if (buttonDisabled || !amountNgn) return;
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

	// Inline panel = just the amount input. Everything else lives in the modal.
</script>

<!-- ═══ YOU PAY (NGN input) ═══ -->
<div class="flex flex-col bg-(--bg-surface-input) rounded-xl overflow-hidden">
	<div class="flex justify-between items-start px-3.5 pt-3 pb-1.5">
		<span class="font-mono text-xs4 font-semibold uppercase tracking-[0.05em] text-(--text-muted)">{$t('trade.youPay')}</span>
		<div class="flex items-center gap-1.5 px-2 py-1 rounded-full bg-(--bg-surface) border border-(--border)">
			<div class="w-4 h-4 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
				<span class="font-mono text-3xs font-bold text-emerald-300">₦</span>
			</div>
			<span class="font-mono text-3xs font-bold text-(--text-heading) tabular-nums">NGN</span>
		</div>
	</div>
	<div class="px-3.5 pb-3 pt-1 flex items-baseline gap-2">
		<span class="font-numeric text-22 font-bold text-(--text-muted) shrink-0">₦</span>
		<input
			type="text"
			inputmode="numeric"
			pattern="[0-9]*"
			placeholder="0"
			class="flex-1 bg-transparent border-0 outline-none font-numeric text-28 font-bold text-(--text-heading) leading-[1.2] tabular-nums w-full"
			value={amountNgn ?? ''}
			oninput={(e) => {
				const digits = (e.currentTarget as HTMLInputElement).value.replace(/[^0-9]/g, '');
				amountNgn = digits ? Number(digits) : null;
				(e.currentTarget as HTMLInputElement).value = digits;
			}}
			disabled={flow !== 'idle'}
		/>
	</div>
	<div class="px-3.5 pb-3 -mt-1">
		<span class="font-mono text-3xs text-(--text-dim)">Min ₦{minNgn.toLocaleString()}</span>
	</div>
</div>

<!-- ═══ YOU RECEIVE (USDT preview) ═══ -->
<div class="flex flex-col bg-(--bg-surface-input) rounded-xl overflow-hidden mt-2">
	<div class="flex justify-between items-start px-3.5 pt-3 pb-1.5">
		<span class="font-mono text-xs4 font-semibold uppercase tracking-[0.05em] text-(--text-muted)">{$t('trade.youReceive')}</span>
		<div class="flex items-center gap-1.5 px-2 py-1 rounded-full bg-(--bg-surface) border border-(--border)">
			<svg width="16" height="16" viewBox="0 0 339 295" xmlns="http://www.w3.org/2000/svg" class="shrink-0"><path d="M62.15.5h214.49a4.75 4.75 0 0 1 4.21 2.21l56.51 94.65a4.85 4.85 0 0 1-.43 5.62L173.31 292.13a4.92 4.92 0 0 1-7.4 0L2.05 102.93a4.85 4.85 0 0 1-.43-5.62L58.13 2.71A4.75 4.75 0 0 1 62.15.5Z" fill="#50AF95"/><path d="M191.19 144.8c-1.2.09-7.4.46-21.23.46-11 0-18.81-.33-21.55-.46-42.51-1.87-74.24-9.27-74.24-18.13s31.73-16.25 74.24-18.15v28.91c2.78.2 10.74.67 21.74.67 13.2 0 19.81-.55 21-.66v-28.9c42.42 1.89 74.08 9.29 74.08 18.13s-31.65 16.24-74.08 18.12l.04.01ZM191.19 105.6V79.73h59.21V40.29H88.61v39.44h59.2V105.6c-48.11 2.21-84.29 11.74-84.29 23.16s36.18 20.94 84.29 23.16v82.9h43.38v-82.93c48-2.21 84.12-11.74 84.12-23.15s-36.08-20.94-84.12-23.16v.02Z" fill="#fff"/></svg>
			<span class="font-mono text-3xs font-bold text-(--text-heading)">USDT</span>
		</div>
	</div>
	<div class="px-3.5 pb-3 pt-1">
		{#if rateLoading}
			<span class="block font-numeric text-22 font-bold text-(--text-dim) leading-[1.2]">Loading…</span>
		{:else if livePreviewUsdt !== null}
			<span class="block font-numeric text-28 font-bold text-[#10b981] leading-[1.2] tabular-nums">{livePreviewUsdt.toFixed(4)}</span>
		{:else}
			<span class="block font-numeric text-28 font-bold text-(--text-dim) leading-[1.2]">0.0000</span>
		{/if}
	</div>
	{#if liveRate !== null}
		<div class="flex justify-between items-center px-3.5 pb-3 -mt-1">
			<span class="font-mono text-3xs text-(--text-dim)">Rate</span>
			<span class="font-numeric text-3xs text-(--text-muted) tabular-nums">₦{liveRate.toFixed(2)} / $1</span>
		</div>
	{/if}
</div>

<!-- ═══ Receiver chip — show where the USDT will land ═══ -->
{#if effectiveReceiver}
	<div class="flex items-center justify-between gap-2 mt-2 px-3 py-2 rounded-[10px] bg-(--bg-surface) border border-(--border)">
		<div class="flex items-center gap-2 min-w-0">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-(--text-muted) shrink-0">
				<rect x="2" y="6" width="20" height="14" rx="2"/>
				<path d="M2 10h20"/>
				<path d="M6 14h2"/>
			</svg>
			<span class="font-mono text-3xs text-(--text-muted) shrink-0">Sent to</span>
			<span class="font-mono text-3xs text-(--text-heading) truncate tabular-nums">{effectiveReceiver.slice(0, 8)}…{effectiveReceiver.slice(-6)}</span>
		</div>
		<span class="font-mono text-3xs text-emerald-300/80 shrink-0">~5 min</span>
	</div>
{/if}

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
		{/if}
	</ConfirmModalShell>
{/if}

<!-- Post-submit: delegate to the same modal as history rows so the
     awaiting/received/delivered/expired/failed states have one
     consistent design. -->
{#if postSubmit && statusRow}
	<OnrampStatusModal
		row={statusRow}
		onClose={() => {
			if (flow === 'delivered') {
				try { onsuccess?.(lastDeliveryTx ?? ''); } catch {}
			}
			reset();
		}}
	/>
	{#if flow === 'delivered'}
		<SuccessBurst show={burstTrigger} onComplete={() => (burstTrigger = false)} />
	{/if}
{/if}
