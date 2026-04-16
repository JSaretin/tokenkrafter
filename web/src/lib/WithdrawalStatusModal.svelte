<script lang="ts">
	import { onDestroy } from 'svelte';
	import { supabase } from '$lib/supabaseClient';

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
	let liveStatus = $state(withdrawal?.status || 'pending');
	let liveNote = $state(withdrawal?.admin_note || '');
	let confirmedAt = $state<string | null>(withdrawal?.confirmed_at || null);

	// Live countdown tick
	const tickInterval = setInterval(() => { tickNow = Date.now(); }, 1000);

	// Subscribe to realtime updates on this withdrawal
	const channel = supabase
		.channel(`withdrawal-${withdrawal?.id}-${Date.now()}`)
		.on('postgres_changes', {
			event: '*',
			schema: 'public',
			table: 'withdrawal_requests'
		}, (payload: any) => {
			// Match by withdraw_id since DB id might not be known
			const row = payload.new;
			if (row && (
				row.id === withdrawal?.id ||
				(row.withdraw_id === withdrawal?.withdraw_id && row.chain_id === withdrawal?.chain_id) ||
				row.wallet_address?.toLowerCase() === withdrawal?.wallet_address?.toLowerCase()
			)) {
				if (row.status !== liveStatus) {
					liveStatus = row.status;
					liveNote = row.admin_note || '';
					if (row.confirmed_at) confirmedAt = row.confirmed_at;
				}
			}
		})
		.subscribe();

	// Fallback poll every 5s in case Realtime misses an update — stops once
	// we reach a terminal state (confirmed/cancelled) so we don't hammer the API.
	const pollInterval = setInterval(async () => {
		if (liveStatus === 'confirmed' || liveStatus === 'cancelled') return;
		try {
			const res = await fetch('/api/withdrawals?limit=10', { credentials: 'include' });
			if (!res.ok) return;
			const rows = await res.json();
			const match = rows?.find?.((r: any) =>
				r.id === withdrawal?.id ||
				(r.withdraw_id === withdrawal?.withdraw_id && r.chain_id === withdrawal?.chain_id)
			);
			if (match && match.status !== liveStatus) {
				liveStatus = match.status;
				liveNote = match.admin_note || liveNote;
				if (match.confirmed_at) confirmedAt = match.confirmed_at;
			}
		} catch {}
	}, 5000);

	onDestroy(() => {
		clearInterval(tickInterval);
		clearInterval(pollInterval);
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
	let expiresAt = $derived(withdrawal?.expiresAt || withdrawal?.expires_at ? Math.floor(new Date(withdrawal.expires_at || 0).getTime() / 1000) || withdrawal.expiresAt : 0);
	let totalDuration = $derived(expiresAt > createdAt ? expiresAt - createdAt : 600);
	let nowSec = $derived(Math.floor(tickNow / 1000));
	let remaining = $derived(expiresAt > 0 ? Math.max(0, expiresAt - nowSec) : Math.max(0, totalDuration - (nowSec - createdAt)));
	let elapsed = $derived(nowSec - createdAt);
	let progressPct = $derived(totalDuration > 0 ? Math.min(100, (elapsed / totalDuration) * 100) : 100);
	let canCancel = $derived((liveStatus === 'pending' || liveStatus === 'timeout') && remaining <= 0);
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
	let details = $derived(withdrawal?.payment_details || {});
	let bankLabel = $derived(details?.bank_name || details?.bank_code || details?.email || 'your account');
	let refId = $derived(withdrawal?.withdraw_id ? `#${withdrawal.withdraw_id}` : '');
	let txExplorerLink = $derived(
		withdrawal?.tx_hash && explorerUrl
			? `${explorerUrl.replace(/\/$/, '')}/tx/${withdrawal.tx_hash}`
			: ''
	);
	let confirmedAtDisplay = $derived(
		confirmedAt ? new Date(confirmedAt).toLocaleString() : ''
	);

	let statusConfig = $derived.by(() => {
		switch (liveStatus) {
			case 'confirmed': return { label: 'Confirmed', color: '#10b981', bg: 'rgba(16,185,129,0.1)', icon: 'M20 6L9 17l-5-5' };
			case 'processing': return { label: 'Processing', color: '#00d2ff', bg: 'rgba(0,210,255,0.1)', icon: 'M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83' };
			case 'cancelled': return { label: 'Cancelled', color: '#f87171', bg: 'rgba(239,68,68,0.1)', icon: 'M18 6L6 18M6 6l12 12' };
			case 'timeout': return { label: 'Timed Out', color: '#f87171', bg: 'rgba(239,68,68,0.1)', icon: 'M12 2a10 10 0 100 20 10 10 0 000-20zM12 6v6l4 2' };
			default: return { label: 'Pending', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', icon: 'M12 2v4m0 12v4' };
		}
	});
</script>

<div class="modal-backdrop" onclick={onclose} role="dialog" aria-modal="true">
	<div class="status-modal" onclick={(e) => e.stopPropagation()}>
		<!-- Header -->
		<div class="status-header">
			<h3>{liveStatus === 'confirmed' ? 'Payment Sent!' : liveStatus === 'cancelled' ? 'Withdrawal Cancelled' : 'Processing Withdrawal'}</h3>
			<button class="close-btn" onclick={onclose}>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
			</button>
		</div>

		<div class="status-body">
			{#if liveStatus === 'confirmed' || liveStatus === 'processing'}
				<!-- ═══ RECEIPT VIEW ═══ -->
				<div class="receipt">
					<div class="receipt-check">
						<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
					</div>
					<div class="receipt-amount">${usdtAmount.toFixed(2)}</div>
					{#if ngnAmount > 0}
						<div class="receipt-fiat">NGN {ngnAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
					{/if}
					<div class="receipt-divider"></div>
					<div class="receipt-rows">
						<div class="receipt-row">
							<span>Status</span>
							<span class="receipt-status">{liveStatus === 'confirmed' ? 'Sent' : 'Processing'}</span>
						</div>
						{#if details.bank_name || details.bank_code}
							<div class="receipt-row">
								<span>Bank</span>
								<span>{details.bank_name || details.bank_code}</span>
							</div>
						{/if}
						{#if details.account}
							<div class="receipt-row">
								<span>Account</span>
								<span>{details.account}</span>
							</div>
						{/if}
						{#if details.holder}
							<div class="receipt-row">
								<span>Recipient</span>
								<span class="receipt-highlight">{details.holder}</span>
							</div>
						{:else if details.email}
							<div class="receipt-row">
								<span>Email</span>
								<span>{details.email}</span>
							</div>
						{/if}
						{#if ngnAmount > 0}
							<div class="receipt-row">
								<span>Rate</span>
								<span>1 USD = NGN {ngnRate.toFixed(2)}</span>
							</div>
						{/if}
						<div class="receipt-row">
							<span>Date</span>
							<span>{new Date(withdrawal?.created_at || Date.now()).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
						</div>
					</div>
				</div>
				<button class="done-btn" onclick={onclose}>Done</button>
			{:else}
				<!-- ═══ PENDING / TIMED OUT VIEW ═══ -->
				<div class="status-icon-wrap" style="background: {statusConfig.bg};">
					{#if liveStatus === 'pending' && remaining > 0}
						<div class="spinner-lg" style="border-top-color: {statusConfig.color};"></div>
					{:else if liveStatus === 'pending' && remaining <= 0}
						<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
					{:else}
						<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={statusConfig.color} stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d={statusConfig.icon}/></svg>
					{/if}
				</div>

				{#if liveStatus === 'pending' && remaining <= 0}
					<div class="status-label" style="color: #f87171;">Timed Out</div>
				{:else if liveStatus === 'cancelled'}
					<div class="status-label" style="color: {statusConfig.color};">{statusConfig.label}</div>
				{:else}
					<div class="status-label" style="color: {statusConfig.color};">{statusConfig.label}</div>
				{/if}

				{#if liveStatus === 'pending'}
					<div class="countdown-timer">
						{#if remaining > 0}
							<span class="timer-digits">{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</span>
						{:else}
							<span class="timer-expired">0:00</span>
						{/if}
					</div>
					<div class="countdown-bar-wrap">
						<div class="countdown-bar">
							<div class="countdown-fill" style="width: {progressPct}%; background: {remaining > 0 ? 'linear-gradient(90deg, #f59e0b, #d97706)' : 'linear-gradient(90deg, #f87171, #dc2626)'}"></div>
						</div>
					</div>
				{/if}

				<div class="status-amount">${usdtAmount.toFixed(2)}</div>
				{#if ngnAmount > 0}
					<div class="status-fiat">≈ NGN {ngnAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
				{/if}

				<!-- Step tracker -->
				{#if liveStatus === 'cancelled'}
					<div class="step-tracker">
						<div class="step step-done">
							<div class="step-dot"></div>
							<span>Deposited</span>
						</div>
						<div class="step-line step-line-done"></div>
						<div class="step step-done">
							<div class="step-dot"></div>
							<span>Refunded</span>
						</div>
					</div>
				{:else if liveStatus === 'pending' && remaining <= 0}
					<div class="step-tracker">
						<div class="step step-done">
							<div class="step-dot"></div>
							<span>Deposited</span>
						</div>
						<div class="step-line step-line-expired"></div>
						<div class="step step-expired">
							<div class="step-dot"></div>
							<span>Expired</span>
						</div>
					</div>
				{:else}
					{@const step = liveStatus === 'confirmed' ? 3 : (liveStatus === 'processing' ? 2 : 1)}
					<div class="step-tracker">
						<div class="step" class:step-done={step >= 1} class:step-active={step === 1 && remaining > 0}>
							<div class="step-dot"></div>
							<span>Deposited</span>
						</div>
						<div class="step-line" class:step-line-done={step >= 2}></div>
						<div class="step" class:step-done={step >= 2} class:step-active={step === 2}>
							<div class="step-dot"></div>
							<span>Processing</span>
						</div>
						<div class="step-line" class:step-line-done={step >= 3}></div>
						<div class="step" class:step-done={step >= 3}>
							<div class="step-dot"></div>
							<span>Sent</span>
						</div>
					</div>
				{/if}

				<div class="details-card">
					{#if refId}
						<div class="detail-row">
							<span>Reference</span>
							<span>{refId}</span>
						</div>
					{/if}
					{#if details.bank_name || details.bank_code}
						<div class="detail-row">
							<span>Bank</span>
							<span>{details.bank_name || details.bank_code}</span>
						</div>
					{/if}
					{#if details.account}
						<div class="detail-row">
							<span>Account</span>
							<span>{details.account}</span>
						</div>
					{/if}
					{#if details.holder}
						<div class="detail-row detail-row-highlight">
							<span>Recipient</span>
							<span>{details.holder}</span>
						</div>
					{:else if details.email}
						<div class="detail-row">
							<span>Email</span>
							<span>{details.email}</span>
						</div>
					{/if}
					{#if feeAmount > 0}
						<div class="detail-row">
							<span>Fee</span>
							<span>${feeAmount.toFixed(2)}</span>
						</div>
						<div class="detail-row">
							<span>You receive</span>
							<span class="detail-highlight">${netAmount.toFixed(2)}</span>
						</div>
					{/if}
					{#if ngnRate > 0}
						<div class="detail-row">
							<span>Rate</span>
							<span>1 USD = NGN {ngnRate.toFixed(2)}</span>
						</div>
					{/if}
					{#if txExplorerLink}
						<div class="detail-row">
							<span>Tx</span>
							<a class="detail-link" href={txExplorerLink} target="_blank" rel="noopener noreferrer">
								{withdrawal.tx_hash?.slice(0, 10)}...
								<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
							</a>
						</div>
					{/if}
				</div>

				{#if canCancel && oncancel}
					<button class="cancel-action-btn" onclick={() => oncancel?.(withdrawal.withdraw_id)}>
						Cancel & Return Funds
					</button>
				{/if}

				{#if liveStatus === 'confirmed'}
					<div class="success-card">
						<div class="success-row">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
							<span>Payment sent to {bankLabel}</span>
						</div>
						{#if confirmedAtDisplay}
							<div class="success-sub">{confirmedAtDisplay}</div>
						{/if}
					</div>
					<button class="done-btn" onclick={onclose}>Done</button>
				{/if}
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
	.status-header h3 {
		font-family: 'Syne', sans-serif; font-size: 16px; font-weight: 700;
		color: var(--text-heading); margin: 0;
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

	.countdown-timer { margin: 8px 0 4px; }
	.timer-digits {
		font-family: 'Syne', sans-serif; font-size: 36px; font-weight: 800;
		color: #f59e0b; letter-spacing: 0.05em;
	}
	.timer-expired {
		font-family: 'Syne', sans-serif; font-size: 36px; font-weight: 800;
		color: #f87171; letter-spacing: 0.05em;
	}
	.countdown-bar-wrap { margin-bottom: 16px; padding: 0 20px; }
	.countdown-bar {
		width: 100%; height: 4px; background: var(--bg-surface-hover);
		border-radius: 2px; overflow: hidden;
	}
	.countdown-fill { height: 100%; border-radius: 2px; transition: width 1s linear; }

	/* Receipt (confirmed/processing) */
	.receipt { margin-bottom: 16px; }
	.receipt-check {
		width: 64px; height: 64px; border-radius: 50%; margin: 0 auto 12px;
		background: rgba(16,185,129,0.1);
		display: flex; align-items: center; justify-content: center;
	}
	.receipt-amount {
		font-family: 'Syne', sans-serif; font-size: 28px; font-weight: 800;
		color: var(--text-heading); margin-bottom: 2px;
	}
	.receipt-fiat {
		font-family: 'Rajdhani', sans-serif; font-size: 18px; font-weight: 700;
		color: #10b981; margin-bottom: 16px;
	}
	.receipt-divider {
		height: 1px; background: var(--border);
		margin: 0 -20px 16px; /* bleed to edges */
		border-style: dashed; border-width: 1px 0 0; border-color: var(--border);
		background: none;
	}
	.receipt-rows { text-align: left; }
	.receipt-row {
		display: flex; justify-content: space-between; padding: 6px 0;
		font-family: 'Space Mono', monospace; font-size: 12px;
	}
	.receipt-row span:first-child { color: var(--text-muted); }
	.receipt-row span:last-child { color: var(--text); }
	.receipt-status { color: #10b981 !important; font-weight: 700; }
	.receipt-highlight { color: #10b981 !important; font-weight: 700; }

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
