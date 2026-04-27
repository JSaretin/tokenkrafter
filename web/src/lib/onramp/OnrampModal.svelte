<script lang="ts">
	/**
	 * OnrampModal — singleton on-ramp UI. Subscribes to onrampStore;
	 * mount once per page where the on-ramp can be invoked. Currently
	 * only the trade page mounts it. The user clicks any
	 * "Buy USDT with naira" trigger anywhere on that page → store
	 * opens the modal.
	 *
	 * State machine:
	 *   idle → quoting → quoted → signing → submitting →
	 *     awaiting_payment → payment_received → delivering → delivered
	 *   forks: expired | failed | cancelled
	 */
	import { onDestroy } from 'svelte';
	import { ethers } from 'ethers';
	import { getContext } from 'svelte';
	import { onrampStore, type OnrampOpenParams } from './store';
	import { ONRAMP_DOMAIN, ONRAMP_TYPES, type BankDetails, type OnrampIntent, type OnrampQuote } from './types';
	import { quoteOnramp, submitOnrampIntent, getOnrampStatus, cancelOnrampIntent } from './client';
	import SuccessBurst from '$lib/SuccessBurst.svelte';

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

	let openParams = $state<OnrampOpenParams | null>(null);
	let flow = $state<State>('idle');
	let amountNgn = $state(5000);
	let quote = $state<OnrampQuote | null>(null);
	let bankDetails = $state<BankDetails | null>(null);
	let errorMsg = $state('');
	let secondsLeft = $state(0);
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let countdownTimer: ReturnType<typeof setInterval> | null = null;
	let lastDeliveryTx = $state<string | null>(null);
	let burstTrigger = $state(false);

	const PRESET_AMOUNTS = [2000, 5000, 10000, 20000, 50000];

	let getSigner: () => ethers.Signer | null = getContext('signer');
	let getUserAddress: () => string | null = getContext('userAddress');
	let connectWallet: () => Promise<boolean> = getContext('connectWallet');

	let signer = $derived(getSigner());
	let userAddress = $derived(getUserAddress());

	const unsub = onrampStore.subscribe((p) => {
		if (p && !openParams) {
			openParams = p;
			amountNgn = p.ngnAmount && p.ngnAmount > 0 ? p.ngnAmount : 5000;
			flow = 'idle';
			errorMsg = '';
			quote = null;
			bankDetails = null;
		} else if (!p && openParams) {
			openParams = null;
			cleanup();
		}
	});

	function cleanup() {
		if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
		if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
		quote = null;
		bankDetails = null;
		flow = 'idle';
		errorMsg = '';
		secondsLeft = 0;
	}

	onDestroy(() => {
		unsub();
		cleanup();
	});

	function close() {
		// Refuse to close while we're mid-broadcast.
		if (flow === 'signing' || flow === 'submitting' || flow === 'delivering') return;
		onrampStore.close();
	}

	let usdtPreview = $derived(quote
		? Number(BigInt(quote.usdt_amount_wei) * 10000n / 10n ** 18n) / 10000
		: null);
	let ratePreview = $derived(quote ? quote.rate_x100 / 100 : null);

	async function handleGetQuote() {
		errorMsg = '';
		flow = 'quoting';
		try {
			quote = await quoteOnramp(amountNgn);
			flow = 'quoted';
		} catch (e) {
			errorMsg = (e as Error).message;
			flow = 'idle';
		}
	}

	async function handleCreatePayment() {
		if (!quote) return;
		errorMsg = '';

		// Connect wallet if needed
		if (!signer || !userAddress) {
			try {
				await connectWallet();
			} catch {}
			if (!signer || !userAddress) {
				errorMsg = 'Connect your wallet to continue';
				return;
			}
		}

		flow = 'signing';
		const intent: OnrampIntent = {
			receiver: openParams?.receiver ?? userAddress,
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
			// ethers v6: signer.signTypedData(domain, types, value)
			signature = await (signer as ethers.Signer).signTypedData(
				ONRAMP_DOMAIN(quote.chain_id),
				ONRAMP_TYPES,
				intent,
			);
		} catch (e) {
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
					if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
					if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
					// Fire success callback for the host page (e.g. trade page
					// re-runs its swap quote with the freshly arrived USDT).
					try { openParams?.onSuccess?.(s.delivery_tx_hash ?? ''); } catch {}
					setTimeout(() => onrampStore.close(), 3000);
				} else if (s.status === 'failed') {
					flow = 'failed';
					errorMsg = s.failure_reason ?? 'Payment failed';
					if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
				} else if (s.status === 'cancelled' || s.status === 'expired') {
					flow = s.status as State;
					if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
				}
			} catch {
				// Transient errors are fine; we'll try again next tick.
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
				if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
			}
		}, 1000);
	}

	async function handleCancel() {
		if (!quote) { onrampStore.close(); return; }
		try {
			await cancelOnrampIntent(quote.reference);
		} catch {}
		flow = 'cancelled';
		setTimeout(() => onrampStore.close(), 800);
	}

	function copyText(t: string) {
		try { navigator.clipboard?.writeText(t); } catch {}
	}

	function fmtCountdown(s: number): string {
		const m = Math.floor(s / 60);
		const ss = (s % 60).toString().padStart(2, '0');
		return `${m}:${ss}`;
	}

	let isOpen = $derived(openParams !== null);
</script>

{#if isOpen}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-[1000] bg-black/70 backdrop-blur flex items-center justify-center p-4 max-[480px]:p-0 max-[480px]:items-end"
		onclick={close}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<div
			class="w-full max-w-[440px] max-h-[80vh] max-[480px]:max-w-full max-[480px]:max-h-[80vh] bg-surface border border-white/[0.08] rounded-[20px] max-[480px]:rounded-b-none overflow-y-auto flex flex-col shadow-[0_20px_60px_rgba(0,0,0,0.5)]"
			onclick={(e) => e.stopPropagation()}
		>
			<!-- Header -->
			<div class="flex items-center justify-between px-5 py-4 border-b border-(--border)">
				<div>
					<h3 class="syne text-base font-bold text-(--text-heading) m-0">Buy USDT with naira</h3>
					<p class="font-mono text-xs2 text-(--text-muted) mt-0.5 m-0">Pay from any Nigerian bank app</p>
				</div>
				<button class="p-1 rounded-md text-(--text-muted) hover:text-(--text-heading) hover:bg-(--bg-surface-hover)" onclick={close} aria-label="Close" disabled={flow === 'signing' || flow === 'submitting' || flow === 'delivering'}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>

			<div class="p-5 flex flex-col gap-4">
				{#if flow === 'idle' || flow === 'quoting' || flow === 'quoted'}
					<!-- Amount picker -->
					<label class="block">
						<span class="block text-xs2 font-mono text-(--text-muted) mb-1.5">Amount (NGN)</span>
						<div class="flex items-center gap-2 px-3.5 py-2.5 rounded-[10px] bg-(--bg-surface-input) border border-(--border-input) focus-within:border-cyan-400/50">
							<span class="font-mono text-sm text-(--text-muted) shrink-0">₦</span>
							<input
								type="number"
								inputmode="numeric"
								min="500"
								max="50000"
								step="500"
								class="flex-1 bg-transparent border-0 outline-none font-numeric text-base text-(--text-heading)"
								bind:value={amountNgn}
								disabled={flow !== 'idle' && flow !== 'quoted'}
							/>
						</div>
					</label>

					<div class="flex flex-wrap gap-1.5">
						{#each PRESET_AMOUNTS as preset}
							<button
								type="button"
								class={'px-3 py-1.5 rounded-md font-mono text-xs2 border transition ' + (amountNgn === preset ? 'bg-cyan-400/10 border-cyan-400/40 text-cyan-300' : 'bg-(--bg-surface) border-(--border) text-(--text-muted) hover:text-(--text-heading)')}
								onclick={() => { amountNgn = preset; if (flow === 'quoted') { quote = null; flow = 'idle'; } }}
								disabled={flow === 'quoting'}
							>
								₦{preset.toLocaleString()}
							</button>
						{/each}
					</div>

					{#if flow === 'quoted' && quote}
						<div class="rounded-xl border border-emerald-500/15 bg-emerald-500/[0.04] px-4 py-3">
							<div class="flex items-center justify-between">
								<span class="font-mono text-xs2 text-(--text-muted)">You'll receive</span>
								<span class="font-numeric text-15 font-bold text-emerald-300">{usdtPreview?.toFixed(4)} USDT</span>
							</div>
							<div class="flex items-center justify-between mt-1">
								<span class="font-mono text-xs2 text-(--text-muted)">Rate</span>
								<span class="font-numeric text-xs2 text-(--text-muted)">₦{ratePreview?.toFixed(2)} / $1</span>
							</div>
							<p class="font-mono text-3xs text-(--text-dim) mt-2 m-0">No spread. The rate locks in when you sign.</p>
						</div>
					{/if}

					{#if errorMsg}
						<p class="font-mono text-xs2 text-red-400 m-0">{errorMsg}</p>
					{/if}

					<div class="flex gap-2">
						{#if flow === 'quoted'}
							<button class="flex-1 py-3 rounded-xl bg-(--bg-surface) border border-(--border) text-(--text-muted) syne text-xs font-bold cursor-pointer hover:bg-(--bg-surface-hover)" onclick={() => { quote = null; flow = 'idle'; }}>
								Change amount
							</button>
							<button class="flex-1 py-3 rounded-xl bg-gradient-to-br from-cyan-400 to-blue-500 text-white syne text-xs font-bold cursor-pointer disabled:opacity-50" onclick={handleCreatePayment} disabled={!amountNgn || amountNgn < 500}>
								Sign &amp; create payment
							</button>
						{:else}
							<button class="w-full py-3 rounded-xl bg-gradient-to-br from-cyan-400 to-blue-500 text-white syne text-xs font-bold cursor-pointer disabled:opacity-50" onclick={handleGetQuote} disabled={!amountNgn || amountNgn < 500 || flow === 'quoting'}>
								{flow === 'quoting' ? 'Getting quote…' : 'Get quote'}
							</button>
						{/if}
					</div>
				{:else if flow === 'signing'}
					<div class="flex flex-col items-center gap-3 py-6">
						<div class="w-10 h-10 rounded-full border-2 border-cyan-400/30 border-t-cyan-400 animate-spin"></div>
						<p class="font-mono text-xs text-(--text-muted) text-center m-0">Sign in your wallet to confirm the receiver address.</p>
					</div>
				{:else if flow === 'submitting'}
					<div class="flex flex-col items-center gap-3 py-6">
						<div class="w-10 h-10 rounded-full border-2 border-cyan-400/30 border-t-cyan-400 animate-spin"></div>
						<p class="font-mono text-xs text-(--text-muted) text-center m-0">Generating your bank details…</p>
					</div>
				{:else if flow === 'awaiting_payment' && bankDetails}
					<div class="rounded-xl border border-cyan-400/15 bg-cyan-400/[0.04] p-4 flex flex-col gap-3">
						<div>
							<span class="block font-mono text-xs2 text-(--text-muted)">Send exactly</span>
							<span class="block font-numeric text-22 font-bold text-(--text-heading)">₦{bankDetails.amount_ngn.toLocaleString()}</span>
						</div>
						<div class="flex flex-col gap-2">
							<div class="flex items-center justify-between gap-2 px-3 py-2 rounded-[10px] bg-(--bg-surface) border border-(--border)">
								<div class="min-w-0">
									<span class="block font-mono text-3xs text-(--text-muted) uppercase tracking-wide">Bank</span>
									<span class="block font-display text-sm font-bold text-(--text-heading) truncate">{bankDetails.bank_name}</span>
								</div>
							</div>
							<div class="flex items-center justify-between gap-2 px-3 py-2 rounded-[10px] bg-(--bg-surface) border border-(--border)">
								<div class="min-w-0">
									<span class="block font-mono text-3xs text-(--text-muted) uppercase tracking-wide">Account number</span>
									<span class="block font-numeric text-base font-bold text-(--text-heading) tabular-nums">{bankDetails.account_number}</span>
								</div>
								<button class="shrink-0 px-2.5 py-1 rounded-md bg-(--bg-surface-hover) border border-(--border) text-(--text-muted) font-mono text-3xs hover:text-cyan-300" onclick={() => copyText(bankDetails!.account_number)}>Copy</button>
							</div>
							<div class="flex items-center justify-between gap-2 px-3 py-2 rounded-[10px] bg-(--bg-surface) border border-(--border)">
								<div class="min-w-0">
									<span class="block font-mono text-3xs text-(--text-muted) uppercase tracking-wide">Reference</span>
									<span class="block font-mono text-xs2 text-(--text-heading) truncate">{bankDetails.reference}</span>
								</div>
								<button class="shrink-0 px-2.5 py-1 rounded-md bg-(--bg-surface-hover) border border-(--border) text-(--text-muted) font-mono text-3xs hover:text-cyan-300" onclick={() => copyText(bankDetails!.reference)}>Copy</button>
							</div>
						</div>

						<div class="flex items-center gap-2 px-3 py-2 rounded-md bg-amber-500/[0.06] border border-amber-500/15">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" class="shrink-0"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
							<span class="font-mono text-xs2 text-amber-300">Quote expires in {fmtCountdown(secondsLeft)}</span>
						</div>

						<p class="font-mono text-3xs text-(--text-dim) m-0 leading-relaxed">
							Send the exact amount with the reference shown. USDT lands in your wallet within 5 minutes after the bank confirms.
						</p>
					</div>

					<button class="w-full py-2 rounded-lg bg-(--bg-surface) border border-(--border) text-(--text-muted) font-mono text-xs2 hover:text-red-400" onclick={handleCancel}>
						Cancel this payment
					</button>
				{:else if flow === 'payment_received' || flow === 'delivering'}
					<div class="flex flex-col items-center gap-3 py-6">
						<div class="w-10 h-10 rounded-full border-2 border-emerald-400/30 border-t-emerald-400 animate-spin"></div>
						<div class="text-center">
							<p class="font-display text-sm font-bold text-emerald-300 m-0">Payment received ✓</p>
							<p class="font-mono text-xs2 text-(--text-muted) mt-1 m-0">Sending USDT to your wallet…</p>
						</div>
					</div>
				{:else if flow === 'delivered'}
					<div class="flex flex-col items-center gap-3 py-4 relative">
						<SuccessBurst show={burstTrigger} onComplete={() => (burstTrigger = false)} />
						<p class="font-display text-base font-bold text-emerald-300 m-0">USDT in your wallet ✓</p>
						{#if lastDeliveryTx}
							<a href="https://bscscan.com/tx/{lastDeliveryTx}" target="_blank" rel="noopener" class="font-mono text-3xs text-cyan-300 hover:underline truncate max-w-full">{lastDeliveryTx.slice(0, 10)}…{lastDeliveryTx.slice(-8)}</a>
						{/if}
					</div>
				{:else if flow === 'expired'}
					<div class="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4 text-center">
						<p class="font-display text-sm font-bold text-amber-300 m-0">Quote expired</p>
						<p class="font-mono text-xs2 text-(--text-muted) mt-1 m-0">Get a fresh quote to continue.</p>
						<button class="mt-3 px-4 py-2 rounded-lg bg-gradient-to-br from-cyan-400 to-blue-500 text-white syne text-xs font-bold" onclick={() => { quote = null; bankDetails = null; flow = 'idle'; }}>
							New quote
						</button>
					</div>
				{:else if flow === 'failed'}
					<div class="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-4">
						<p class="font-display text-sm font-bold text-red-300 m-0">Payment failed</p>
						<p class="font-mono text-xs2 text-(--text-muted) mt-1 m-0">{errorMsg}</p>
						<button class="mt-3 px-4 py-2 rounded-lg bg-(--bg-surface) border border-(--border) text-(--text-muted) syne text-xs font-bold" onclick={() => { quote = null; bankDetails = null; flow = 'idle'; errorMsg = ''; }}>
							Try again
						</button>
					</div>
				{:else if flow === 'cancelled'}
					<p class="font-mono text-xs text-(--text-muted) text-center py-4 m-0">Cancelled.</p>
				{/if}
			</div>
		</div>
	</div>
{/if}
