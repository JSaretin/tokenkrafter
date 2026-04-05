<script lang="ts">
	import { onDestroy } from 'svelte';
	import { supabase } from '$lib/supabaseClient';

	let {
		withdrawal,
		onclose,
		oncancel,
		usdtDecimals = 18
	}: {
		withdrawal: any;
		onclose: () => void;
		oncancel?: (id: number) => void;
		usdtDecimals?: number;
	} = $props();

	let tickNow = $state(Date.now());
	let liveStatus = $state(withdrawal?.status || 'pending');
	let liveNote = $state(withdrawal?.admin_note || '');

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
				}
			}
		})
		.subscribe();

	// No polling needed — daemon writes to DB, Supabase Realtime pushes to us

	onDestroy(() => {
		clearInterval(tickInterval);
		supabase.removeChannel(channel);
	});

	// Fetch NGN rate
	let ngnRate = $state(0);
	$effect(() => {
		(async () => {
			try {
				const res = await fetch('/api/rates?currencies=NGN');
				if (res.ok) {
					const data = await res.json();
					if (data.rates?.NGN) ngnRate = data.rates.NGN * 0.997; // 0.3% spread
				}
			} catch {}
		})();
	});

	// Derived
	let createdAt = $derived(withdrawal?.created_at ? Math.floor(new Date(withdrawal.created_at).getTime() / 1000) : 0);
	let elapsed = $derived(Math.floor(tickNow / 1000) - createdAt);
	let timeoutSec = 300; // 5 min
	let remaining = $derived(Math.max(0, timeoutSec - elapsed));
	let progressPct = $derived(Math.min(100, (elapsed / timeoutSec) * 100));
	let canCancel = $derived((liveStatus === 'pending' || liveStatus === 'timeout') && remaining <= 0);
	let usdtAmount = $derived(parseFloat(withdrawal?.gross_amount || '0') / (10 ** usdtDecimals));
	let ngnAmount = $derived(ngnRate > 0 && usdtAmount > 0 ? usdtAmount * ngnRate : 0);
	let details = $derived(withdrawal?.payment_details || {});

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
			<!-- Status icon -->
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
			{:else}
				<div class="status-label" style="color: {statusConfig.color};">{statusConfig.label}</div>
			{/if}

			<!-- Countdown timer (pending only, big) -->
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

			<!-- Amount -->
			<div class="status-amount">${usdtAmount.toFixed(2)}</div>
			{#if ngnAmount > 0}
				<div class="status-fiat">≈ NGN {ngnAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
			{/if}

			<!-- Admin note -->
			{#if liveNote}
				<div class="admin-note">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
					{liveNote}
				</div>
			{/if}

			<!-- Payment details -->
			<div class="details-card">
				<div class="detail-row">
					<span>Method</span>
					<span>{withdrawal?.payment_method || 'bank'}</span>
				</div>
				{#if details.bank_name || details.bank_code}
					<div class="detail-row">
						<span>Bank</span>
						<span>{details.bank_name || details.bank_code}</span>
					</div>
					{#if details.account}
						<div class="detail-row">
							<span>Account</span>
							<span>{details.account}</span>
						</div>
					{/if}
					{#if details.holder}
						<div class="detail-row detail-row-highlight">
							<span>Name</span>
							<span>{details.holder}</span>
						</div>
					{/if}
				{:else if details.email}
					<div class="detail-row">
						<span>Email</span>
						<span>{details.email}</span>
					</div>
				{/if}
				{#if ngnAmount > 0}
					<div class="detail-row detail-row-highlight">
						<span>NGN Payout</span>
						<span>NGN {ngnAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
					</div>
					<div class="detail-row">
						<span>Rate</span>
						<span>1 USD = NGN {ngnRate.toFixed(2)}</span>
					</div>
				{/if}
				{#if withdrawal?.tx_hash}
					<div class="detail-row">
						<span>Tx</span>
						<span class="tx-hash">{withdrawal.tx_hash.slice(0, 10)}...{withdrawal.tx_hash.slice(-6)}</span>
					</div>
				{/if}
			</div>

			<!-- Actions -->
			{#if canCancel && oncancel}
				<button class="cancel-action-btn" onclick={() => oncancel?.(withdrawal.withdraw_id)}>
					Cancel & Return Funds
				</button>
			{/if}

			{#if liveStatus === 'confirmed'}
				<button class="done-btn" onclick={onclose}>Done</button>
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

	.admin-note {
		display: flex; align-items: flex-start; gap: 6px; padding: 8px 12px;
		background: rgba(0,210,255,0.05); border: 1px solid rgba(0,210,255,0.1);
		border-radius: 8px; margin-bottom: 16px; text-align: left;
		font-family: 'Space Mono', monospace; font-size: 11px; color: #00d2ff;
	}
	.admin-note svg { flex-shrink: 0; margin-top: 1px; }

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
	.tx-hash { font-size: 10px; color: var(--text-dim); }

	.cancel-action-btn {
		width: 100%; padding: 14px; border-radius: 12px; border: 1px solid rgba(239,68,68,0.3);
		background: rgba(239,68,68,0.1); color: #f87171; cursor: pointer;
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700;
		transition: all 200ms;
	}
	.cancel-action-btn:hover { background: rgba(239,68,68,0.2); }

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
