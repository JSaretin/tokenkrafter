<script lang="ts">
	import { onDestroy } from 'svelte';
	import { supabase } from '$lib/supabaseClient';
	import { apiFetch } from '$lib/apiFetch';

	let {
		withdrawal,
		onclose,
		oncancel,
		usdtDecimals = 18,
		lockedNgnRate = 0,
		lockedNgnAmount = 0,
		explorerUrl = ''
	}: {
		withdrawal: any;
		onclose: () => void;
		oncancel?: (id: number) => void;
		usdtDecimals?: number;
		lockedNgnRate?: number;
		lockedNgnAmount?: number;
		explorerUrl?: string;
	} = $props();

	let tickNow = $state(Date.now());
	// Imperative state — initial values come from the prop via the
	// $effect below (Svelte 5 warns about reading reactive props at
	// init since that captures only the first value). Prop-driven
	// updates and external sources (realtime, poll) all funnel through
	// this same state, with the TERMINAL-guard preventing regressions.
	let liveStatus = $state<string>('pending');

	// Live countdown tick — stops once we reach a terminal state
	const tickInterval = setInterval(() => {
		if (liveStatus === 'confirmed' || liveStatus === 'cancelled') return;
		tickNow = Date.now();
	}, 1000);

	// Once we hit confirmed/cancelled, the modal must NEVER revert. Any
	// further "pending" update we see is either stale, from a different
	// row that happens to share a field, or a glitch — ignore it.
	const TERMINAL = ['confirmed', 'cancelled'];

	// String-coerced row match. The DB returns numeric ids, but the
	// receipt-derived view passed in by the parent on auto-open has
	// `id: preData.id` — both should be numbers, but a JSON round-trip
	// could leave one as string. `===` would silently fail to match;
	// coercing keeps the comparison robust regardless.
	function isSameRow(row: any): boolean {
		if (!row || withdrawal == null) return false;
		if (withdrawal.id != null && row.id != null && String(row.id) === String(withdrawal.id)) return true;
		if (
			withdrawal.withdraw_id != null && row.withdraw_id != null &&
			String(row.withdraw_id) === String(withdrawal.withdraw_id) &&
			Number(row.chain_id) === Number(withdrawal.chain_id)
		) return true;
		return false;
	}

	// Subscribe to realtime updates on this withdrawal. No polling
	// fallback — Supabase realtime is the only path. If it drops, the
	// user can close + reopen the modal to pull a fresh snapshot via
	// the parent's history refresh.
	const channel = supabase
		.channel(`withdrawal-${withdrawal?.id}-${Date.now()}`)
		.on('postgres_changes', {
			event: '*',
			schema: 'public',
			table: 'withdrawal_requests'
		}, (payload: any) => {
			const row = payload.new;
			if (!isSameRow(row)) return;
			if (TERMINAL.includes(liveStatus)) return; // never go backwards
			if (row.status !== liveStatus) {
				liveStatus = row.status;
			}
		})
		.subscribe();

	// React to prop updates too — if the parent ever swaps in a fresher
	// `withdrawal` object (e.g. via a history refresh), let its status
	// drive the modal forward. Same terminal guard applies.
	$effect(() => {
		const next = withdrawal?.status;
		if (!next || next === liveStatus) return;
		if (TERMINAL.includes(liveStatus)) return;
		liveStatus = next;
	});

	onDestroy(() => {
		clearInterval(tickInterval);
		supabase.removeChannel(channel);
	});

	// Fetch NGN rate only as a fallback — if the caller locked a rate at
	// confirm time (audit #5/#28), we use that instead so the confirmation
	// screen and processing modal show the same NGN figure.
	let fetchedNgnRate = $state(0);
	$effect(() => {
		if (lockedNgnRate > 0) return; // no need to fetch
		(async () => {
			try {
				const res = await fetch('/api/rates?currencies=NGN');
				if (res.ok) {
					const data = await res.json();
					if (data.rates?.NGN) fetchedNgnRate = data.rates.NGN * 0.997; // 0.3% spread
				}
			} catch {}
		})();
	});
	let ngnRate = $derived(lockedNgnRate > 0 ? lockedNgnRate : fetchedNgnRate);

	// Derived
	let createdAt = $derived(withdrawal?.created_at ? Math.floor(new Date(withdrawal.created_at).getTime() / 1000) : 0);
	// expiresAt comes as a unix timestamp (seconds) from on-chain data.
	// When 0, we don't have an on-chain expiry — show a spinner instead of a countdown.
	let expiresAt = $derived(Number(withdrawal?.expiresAt || withdrawal?.expires_at || 0));
	let hasExpiry = $derived(expiresAt > 0);
	let totalDuration = $derived(hasExpiry ? expiresAt - createdAt : 0);
	let nowSec = $derived(Math.floor(tickNow / 1000));
	let remaining = $derived(hasExpiry ? Math.max(0, expiresAt - nowSec) : -1);
	let progressPct = $derived(totalDuration > 0 ? Math.max(0, (remaining / totalDuration) * 100) : 0);
	let canCancel = $derived((liveStatus === 'pending' || liveStatus === 'timeout') && hasExpiry && remaining <= 0);
	let grossAmount = $derived(parseFloat(withdrawal?.gross_amount || '0') / (10 ** usdtDecimals));
	let feeAmount = $derived(parseFloat(withdrawal?.fee || '0') / (10 ** usdtDecimals));
	let netAmount = $derived(parseFloat(withdrawal?.net_amount || '0') / (10 ** usdtDecimals));
	let usdtAmount = $derived(grossAmount); // display gross as headline
	// Prefer the amount locked at confirm time; otherwise compute live.
	let ngnAmount = $derived(
		lockedNgnAmount > 0
			? lockedNgnAmount
			: (ngnRate > 0 && netAmount > 0 ? netAmount * ngnRate : 0)
	);
	// Payment details — may be empty if user hasn't authed yet.
	// fetchedDetails overrides once the user signs + we load from DB.
	let fetchedDetails = $state<any>(null);
	let detailsLoading = $state(false);
	let details = $derived(fetchedDetails || withdrawal?.payment_details || {});
	let hasDetails = $derived(!!(details.bank_name || details.bank_code || details.account || details.holder || details.email));

	async function loadPaymentDetails() {
		if (detailsLoading || hasDetails) return;
		detailsLoading = true;
		try {
			// apiFetch auto-signs on 401 — prompts user wallet signature
			const wid = withdrawal?.withdraw_id;
			const cid = withdrawal?.chain_id;
			const wallet = withdrawal?.wallet_address?.toLowerCase();
			const res = await apiFetch(`/api/withdrawals?wallet=${wallet || ''}&limit=50`);
			if (!res.ok) { detailsLoading = false; return; }
			const rows: any[] = await res.json();
			// Match by withdraw_id (coerce to number for type safety)
			// Try exact withdraw_id match first, then fall back to most recent
			// matching amount (covers case where daemon hasn't synced the ID yet)
			let match = rows.find((r: any) => {
				if (wid != null && wid > 0 && Number(r.withdraw_id) === Number(wid) && Number(r.chain_id) === Number(cid)) return true;
				if (withdrawal?.id && r.id === withdrawal.id) return true;
				return false;
			});
			if (!match && rows.length > 0) {
				// Fallback: find by gross_amount match (rows are newest-first)
				const gross = withdrawal?.gross_amount;
				if (gross) {
					match = rows.find((r: any) => r.gross_amount === gross && r.payment_details);
				}
			}
			if (match?.payment_details && typeof match.payment_details === 'object') {
				fetchedDetails = match.payment_details;
			}
		} catch {}
		detailsLoading = false;
	}
	let refId = $derived(withdrawal?.withdraw_id ? `#${withdrawal.withdraw_id}` : '');
	let txExplorerLink = $derived(
		withdrawal?.tx_hash && explorerUrl
			? `${explorerUrl.replace(/\/$/, '')}/tx/${withdrawal.tx_hash}`
			: ''
	);
	let isTimedOut = $derived(liveStatus === 'pending' && hasExpiry && remaining <= 0);
	let statusConfig = $derived.by(() => {
		// Pending past on-chain expiry overrides the visual to the
		// timeout treatment, mirroring the on-ramp modal's isExpired
		// short-circuit.
		if (isTimedOut) return { label: 'Timed Out', color: '#f87171', bg: 'rgba(239,68,68,0.1)', icon: 'M12 2a10 10 0 100 20 10 10 0 000-20zM12 6v6l4 2' };
		switch (liveStatus) {
			case 'confirmed': return { label: 'Confirmed', color: '#10b981', bg: 'rgba(16,185,129,0.1)', icon: 'M20 6L9 17l-5-5' };
			case 'processing': return { label: 'Processing', color: '#00d2ff', bg: 'rgba(0,210,255,0.1)', icon: 'M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83' };
			case 'cancelled': return { label: 'Cancelled', color: '#f87171', bg: 'rgba(239,68,68,0.1)', icon: 'M18 6L6 18M6 6l12 12' };
			case 'timeout': return { label: 'Timed Out', color: '#f87171', bg: 'rgba(239,68,68,0.1)', icon: 'M12 2a10 10 0 100 20 10 10 0 000-20zM12 6v6l4 2' };
			default: return { label: 'Pending', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', icon: 'M12 2v4m0 12v4' };
		}
	});
</script>

<div
	class="modal-backdrop fixed inset-0 z-[100] bg-black/75 backdrop-blur-[4px] flex items-center justify-center p-4 max-[640px]:p-0 max-[640px]:items-stretch"
	onclick={onclose}
	onkeydown={(e) => { if (e.key === 'Escape') onclose?.(); }}
	role="dialog"
	aria-modal="true"
	tabindex="-1"
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="status-modal w-full max-w-[400px] h-fit max-h-[calc(100vh-32px)] flex flex-col bg-background border border-line rounded-[20px] overflow-hidden max-[640px]:max-w-full max-[640px]:w-full max-[640px]:h-screen max-[640px]:max-h-screen max-[640px]:rounded-none" onclick={(e) => e.stopPropagation()}>
		<!-- Header -->
		<div class="flex justify-between items-center px-5 py-4 border-b border-line">
			<h3 class="heading-3">{liveStatus === 'confirmed' ? 'Payment Sent!' : liveStatus === 'cancelled' ? 'Withdrawal Cancelled' : 'Processing Withdrawal'}</h3>
			<button class="bg-transparent border-0 text-muted cursor-pointer p-1 rounded-lg transition-all duration-[150ms] hover:text-foreground hover:bg-surface-hover" onclick={onclose} aria-label="Close">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
			</button>
		</div>

		<div class="px-5 py-6 text-center flex-1 overflow-y-auto min-h-0">
				<!-- Status icon — same pattern as OnrampStatusModal: tinted
				     circle, status icon at the center, no spinner / ring /
				     countdown. statusConfig already accounts for the
				     timed-out state (isTimedOut → red clock icon). -->
				<div class="relative w-20 h-20 mx-auto mb-3">
					<div
						class="absolute inset-1 rounded-full flex items-center justify-center"
						style="background: {statusConfig.bg}"
					>
						<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={statusConfig.color} stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d={statusConfig.icon}/></svg>
					</div>
				</div>

				<!-- Status label -->
				<div class="font-mono text-13 font-bold uppercase tracking-[0.1em] mb-3" style="color: {statusConfig.color};">{statusConfig.label}</div>

				<div class="font-display text-28 font-extrabold text-heading mb-1">${usdtAmount.toFixed(2)}</div>
				{#if ngnAmount > 0}
					<div class="font-mono text-sm font-bold text-emerald-500 mb-4">≈ NGN {ngnAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
				{/if}

				<!-- Step tracker -->
				{#if liveStatus === 'cancelled'}
					<div class="flex items-center justify-center my-4">
						<div class="flex flex-col items-center gap-1 font-mono text-3xs text-foreground">
							<div class="w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-emerald-500"></div>
							<span>Awaiting</span>
						</div>
						<div class="w-10 h-0.5 mx-1 mb-[18px] bg-emerald-500"></div>
						<div class="flex flex-col items-center gap-1 font-mono text-3xs text-foreground">
							<div class="w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-emerald-500"></div>
							<span>Refunded</span>
						</div>
					</div>
				{:else if liveStatus === 'pending' && hasExpiry && remaining <= 0}
					<div class="flex items-center justify-center my-4">
						<div class="flex flex-col items-center gap-1 font-mono text-3xs text-foreground">
							<div class="w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-emerald-500"></div>
							<span>Awaiting</span>
						</div>
						<div class="w-10 h-0.5 mx-1 mb-[18px] bg-red-400"></div>
						<div class="flex flex-col items-center gap-1 font-mono text-3xs text-red-400">
							<div class="w-2.5 h-2.5 rounded-full bg-red-400 border-2 border-red-400"></div>
							<span>Expired</span>
						</div>
					</div>
				{:else}
					{@const step = liveStatus === 'confirmed' ? 3 : (liveStatus === 'processing' ? 2 : 1)}
					<div class="flex items-center justify-center my-4">
						<div class={'flex flex-col items-center gap-1 font-mono text-3xs transition-all duration-200 ' + (step >= 1 ? 'text-foreground ' : 'text-muted ') + (step === 1 && (!hasExpiry || remaining > 0) ? 'text-amber-500' : '')}>
							<div class={'w-2.5 h-2.5 rounded-full border-2 transition-all duration-200 ' + (step >= 1 ? 'bg-emerald-500 border-emerald-500' : 'bg-surface-hover border-line') + (step === 1 && (!hasExpiry || remaining > 0) ? ' !bg-amber-500 !border-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.4)]' : '')}></div>
							<span>Awaiting</span>
						</div>
						<div class={'w-10 h-0.5 mx-1 mb-[18px] transition-[background] duration-200 ' + (step >= 2 ? 'bg-emerald-500' : 'bg-line')}></div>
						<div class={'flex flex-col items-center gap-1 font-mono text-3xs transition-all duration-200 ' + (step >= 2 ? 'text-foreground ' : 'text-muted ') + (step === 2 ? 'text-amber-500' : '')}>
							<div class={'w-2.5 h-2.5 rounded-full border-2 transition-all duration-200 ' + (step >= 2 ? 'bg-emerald-500 border-emerald-500' : 'bg-surface-hover border-line') + (step === 2 ? ' !bg-amber-500 !border-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.4)]' : '')}></div>
							<span>Received</span>
						</div>
						<div class={'w-10 h-0.5 mx-1 mb-[18px] transition-[background] duration-200 ' + (step >= 3 ? 'bg-emerald-500' : 'bg-line')}></div>
						<div class={'flex flex-col items-center gap-1 font-mono text-3xs transition-all duration-200 ' + (step >= 3 ? 'text-foreground' : 'text-muted')}>
							<div class={'w-2.5 h-2.5 rounded-full border-2 transition-all duration-200 ' + (step >= 3 ? 'bg-emerald-500 border-emerald-500' : 'bg-surface-hover border-line')}></div>
							<span>Delivered</span>
						</div>
					</div>
				{/if}

				<div class="bg-surface-input rounded-xl p-3 mb-4 text-left">
					{#if refId}
						<div class="flex justify-between py-1 font-mono text-xs2 [&>span:first-child]:text-muted [&>span:last-child]:text-foreground">
							<span>Reference</span>
							<span>{refId}</span>
						</div>
					{/if}
					{#if hasDetails}
						{#if details.bank_name || details.bank_code}
							<div class="flex justify-between py-1 font-mono text-xs2 [&>span:first-child]:text-muted [&>span:last-child]:text-foreground">
								<span>Bank</span>
								<span>{details.bank_name || details.bank_code}</span>
							</div>
						{/if}
						{#if details.account}
							<div class="flex justify-between py-1 font-mono text-xs2 [&>span:first-child]:text-muted [&>span:last-child]:text-foreground">
								<span>Account</span>
								<span>{details.account}</span>
							</div>
						{/if}
						{#if details.holder}
							<div class="flex justify-between py-1 font-mono text-xs2 [&>span:first-child]:text-muted">
								<span>Recipient</span>
								<span class="text-emerald-500 font-bold">{details.holder}</span>
							</div>
						{/if}
						{#if details.email}
							<div class="flex justify-between py-1 font-mono text-xs2 [&>span:first-child]:text-muted [&>span:last-child]:text-foreground">
								<span>Email</span>
								<span>{details.email}</span>
							</div>
						{/if}
					{:else}
						<div class="flex justify-between py-1 font-mono text-xs2 [&>span:first-child]:text-muted">
							<span>Paid to</span>
							<button class="inline-flex items-center gap-1 bg-transparent border-0 p-0 cursor-pointer font-numeric text-xs font-bold text-brand-cyan transition-opacity duration-[150ms] hover:opacity-80 disabled:opacity-50 disabled:cursor-default" onclick={loadPaymentDetails} disabled={detailsLoading}>
								{#if detailsLoading}
									Verifying...
								{:else}
									View payment info
									<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
								{/if}
							</button>
						</div>
					{/if}
					{#if feeAmount > 0}
						<div class="flex justify-between py-1 font-mono text-xs2 [&>span:first-child]:text-muted [&>span:last-child]:text-foreground">
							<span>Fee</span>
							<span>${feeAmount.toFixed(2)}</span>
						</div>
						<div class="flex justify-between py-1 font-mono text-xs2 [&>span:first-child]:text-muted">
							<span>You receive</span>
							<span class="text-emerald-500 font-bold">${netAmount.toFixed(2)}</span>
						</div>
					{/if}
					{#if ngnRate > 0}
						<div class="flex justify-between py-1 font-mono text-xs2 [&>span:first-child]:text-muted [&>span:last-child]:text-foreground">
							<span>Rate</span>
							<span>1 USD = NGN {ngnRate.toFixed(2)}</span>
						</div>
					{/if}
					{#if txExplorerLink}
						<div class="flex justify-between py-1 font-mono text-xs2 [&>span:first-child]:text-muted">
							<span>Tx</span>
							<a class="inline-flex items-center gap-[3px] text-brand-cyan no-underline font-mono text-xs2 hover:underline" href={txExplorerLink} target="_blank" rel="noopener noreferrer">
								{withdrawal.tx_hash?.slice(0, 10)}...
								<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
							</a>
						</div>
					{/if}
				</div>

				{#if canCancel && oncancel}
					<button class="w-full py-3.5 rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 cursor-pointer font-display text-sm font-bold transition-all duration-200 hover:bg-red-500/20" onclick={() => oncancel?.(withdrawal.withdraw_id)}>
						Cancel & Return Funds
					</button>
				{/if}

		</div>
	</div>
</div>

<style>
	.modal-backdrop {
		position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,0.75);
		backdrop-filter: blur(4px); display: flex; align-items: center;
		justify-content: center; padding: 16px;
	}
	.status-modal {
		width: 100%; max-width: 400px; background: var(--bg);
		border: 1px solid var(--border); border-radius: 20px; overflow: hidden;
	}
	.status-header {
		display: flex; justify-content: space-between; align-items: center;
		padding: 16px 20px; border-bottom: 1px solid var(--border);
	}
	.close-btn {
		background: none; border: none; color: var(--text-muted); cursor: pointer;
		padding: 4px; border-radius: 8px; transition: all 150ms;
	}
	.close-btn:hover { color: var(--text); background: var(--bg-surface-hover); }

	.status-body { padding: 24px 20px; text-align: center; }

	.status-icon-wrap {
		width: 64px; height: 64px; border-radius: 50%; margin: 0 auto 12px;
		display: flex; align-items: center; justify-content: center;
	}
	.spinner-lg {
		width: 32px; height: 32px; border: 3px solid var(--border);
		border-top-color: #f59e0b; border-radius: 50%;
		animation: spin 1s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }

	.status-label {
		font-family: 'Space Mono', monospace; font-size: 13px; font-weight: 700;
		text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 8px;
	}
	.status-amount {
		font-family: 'Syne', sans-serif; font-size: 28px; font-weight: 800;
		color: var(--text-heading); margin-bottom: 4px;
	}
	.status-fiat {
		font-family: 'Space Mono', monospace; font-size: 14px; font-weight: 700;
		color: #10b981; margin-bottom: 16px;
	}

	/* Receipt (confirmed/processing) */
	.receipt { margin-bottom: 12px; }
	.receipt-check {
		width: 44px; height: 44px; border-radius: 50%; margin: 0 auto 8px;
		background: rgba(16,185,129,0.1);
		display: flex; align-items: center; justify-content: center;
	}
	.receipt-check svg { width: 28px; height: 28px; }
	.receipt-amount {
		font-family: 'Syne', sans-serif; font-size: 22px; font-weight: 800;
		color: var(--text-heading); margin-bottom: 1px;
	}
	.receipt-fiat {
		font-family: 'Rajdhani', sans-serif; font-size: 15px; font-weight: 700;
		color: #10b981; margin-bottom: 10px;
	}
	.receipt-divider {
		height: 1px;
		margin: 0 -20px 10px;
		border-style: dashed; border-width: 1px 0 0; border-color: var(--border);
		background: none;
	}
	.receipt-rows { text-align: left; }
	.receipt-row {
		display: flex; justify-content: space-between; padding: 4px 0;
		font-family: 'Rajdhani', sans-serif; font-size: 12px;
	}
	.receipt-row span:first-child { color: var(--text-muted); }
	.receipt-row span:last-child { color: var(--text); }
	.receipt-status { color: #10b981 !important; font-weight: 700; }
	.receipt-highlight { color: #10b981 !important; font-weight: 700; }
	.receipt-fetch-btn, .detail-fetch-btn {
		display: inline-flex; align-items: center; gap: 4px;
		background: none; border: none; padding: 0; cursor: pointer;
		font-family: 'Rajdhani', sans-serif; font-size: 12px; font-weight: 700;
		color: #00d2ff; transition: opacity 150ms;
	}
	.receipt-fetch-btn:hover, .detail-fetch-btn:hover { opacity: 0.8; }
	.receipt-fetch-btn:disabled, .detail-fetch-btn:disabled { opacity: 0.5; cursor: default; }
	.receipt-link {
		display: inline-flex; align-items: center; gap: 3px;
		color: #00d2ff; text-decoration: none; font-family: 'Space Mono', monospace; font-size: 12px;
	}
	.receipt-link:hover { text-decoration: underline; }

	.status-waiting { margin: 8px 0 12px; }
	.waiting-text {
		font-family: 'Rajdhani', sans-serif; font-size: 13px;
		color: var(--text-muted); animation: waitPulse 2s ease-in-out infinite;
	}
	@keyframes waitPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

	/* Step tracker */
	.step-tracker {
		display: flex; align-items: center; justify-content: center;
		gap: 0; margin: 16px 0;
	}
	.step {
		display: flex; flex-direction: column; align-items: center; gap: 4px;
		font-family: 'Space Mono', monospace; font-size: 10px; color: var(--text-muted);
	}
	.step-dot {
		width: 10px; height: 10px; border-radius: 50%;
		background: var(--bg-surface-hover); border: 2px solid var(--border);
		transition: all 200ms;
	}
	.step-done .step-dot { background: #10b981; border-color: #10b981; }
	.step-active .step-dot {
		background: #f59e0b; border-color: #f59e0b;
		box-shadow: 0 0 8px rgba(245,158,11,0.4);
	}
	.step-done { color: var(--text); }
	.step-active { color: #f59e0b; }
	.step-line {
		width: 40px; height: 2px; background: var(--border);
		margin: 0 4px; margin-bottom: 18px;
		transition: background 200ms;
	}
	.step-line-done { background: #10b981; }
	.step-line-expired { background: #f87171; }
	.step-expired .step-dot { background: #f87171; border-color: #f87171; }
	.step-expired { color: #f87171; }

	.details-card {
		background: var(--bg-surface-input); border-radius: 12px; padding: 12px;
		margin-bottom: 16px; text-align: left;
	}
	.detail-row {
		display: flex; justify-content: space-between; padding: 4px 0;
		font-family: 'Space Mono', monospace; font-size: 11px;
	}
	.detail-row span:first-child { color: var(--text-muted); }
	.detail-row span:last-child { color: var(--text); }
	.detail-row-highlight span:last-child { color: #10b981; font-weight: 700; }
	.detail-highlight { color: #10b981 !important; font-weight: 700; }
	.detail-link {
		display: inline-flex; align-items: center; gap: 3px;
		color: #00d2ff; text-decoration: none; font-family: 'Space Mono', monospace; font-size: 11px;
	}
	.detail-link:hover { text-decoration: underline; }
	.cancel-action-btn {
		width: 100%; padding: 14px; border-radius: 12px; border: 1px solid rgba(239,68,68,0.3);
		background: rgba(239,68,68,0.1); color: #f87171; cursor: pointer;
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700;
		transition: all 200ms;
	}
	.cancel-action-btn:hover { background: rgba(239,68,68,0.2); }

	.success-card {
		background: rgba(16,185,129,0.08); border: 1px solid rgba(16,185,129,0.25);
		border-radius: 12px; padding: 12px; margin-bottom: 12px;
		display: flex; flex-direction: column; gap: 6px;
	}
	.success-row {
		display: flex; align-items: center; gap: 8px;
		font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700; color: #10b981;
	}
	.success-sub {
		font-family: 'Space Mono', monospace; font-size: 11px; color: var(--text-muted);
		padding-left: 24px;
	}
	.done-btn {
		width: 100%; padding: 14px; border-radius: 12px; border: none;
		background: linear-gradient(135deg, #10b981, #059669); color: white;
		cursor: pointer; font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700;
		transition: all 200ms;
	}
	.done-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 28px rgba(16,185,129,0.3); }

	@media (max-width: 640px) {
		.modal-backdrop { padding: 0; align-items: stretch; }
		.status-modal {
			max-width: 100%; width: 100%; height: 100vh;
			border-radius: 0; max-height: 100vh;
			display: flex; flex-direction: column;
		}
		.status-body { flex: 1; overflow-y: auto; }
	}
</style>
