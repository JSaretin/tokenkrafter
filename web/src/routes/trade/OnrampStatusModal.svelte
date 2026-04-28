<script lang="ts">
	/**
	 * Buy-row status modal — shape mirrors WithdrawalStatusModal:
	 * status-tinted icon + uppercase status label + (countdown when
	 * pending) + big NGN amount + USDT sub-amount + 3-step tracker
	 * (Awaiting → Received → Delivered) + detail card.
	 *
	 * For pending_payment we also surface the bank-transfer details so
	 * the user can resume the transfer if they re-open from history.
	 */
	import { onDestroy } from 'svelte';
	import ConfirmModalShell from './ConfirmModalShell.svelte';

	interface OnrampHistoryRow {
		reference: string;
		status: string;
		chain_id: number;
		ngn_amount_kobo: number;
		usdt_amount_wei: string;
		rate_x100: number;
		expires_at: string;
		created_at: string;
		paid_at: string | null;
		delivered_at: string | null;
		delivery_tx_hash: string | null;
		failure_reason: string | null;
		flutterwave_va_account_number: string | null;
		flutterwave_va_bank_name: string | null;
	}

	let {
		row,
		onClose,
	}: {
		row: OnrampHistoryRow;
		onClose: () => void;
	} = $props();

	// ── Time-aware state ──
	let nowSec = $state(Math.floor(Date.now() / 1000));
	let timer: ReturnType<typeof setInterval> | null = null;
	$effect(() => {
		nowSec = Math.floor(Date.now() / 1000);
		timer = setInterval(() => { nowSec = Math.floor(Date.now() / 1000); }, 1000);
		return () => { if (timer) clearInterval(timer); };
	});
	onDestroy(() => { if (timer) clearInterval(timer); });

	let expiresAtSec = $derived(Math.floor(new Date(row.expires_at).getTime() / 1000));
	let createdAtSec = $derived(Math.floor(new Date(row.created_at).getTime() / 1000));
	let totalWindow = $derived(Math.max(1, expiresAtSec - createdAtSec));
	let remaining = $derived(Math.max(0, expiresAtSec - nowSec));
	let progressPct = $derived(Math.min(100, Math.max(0, (remaining / totalWindow) * 100)));

	let isPending = $derived(row.status === 'pending_payment' || row.status === 'quoted');
	let isInflight = $derived(row.status === 'payment_received' || row.status === 'delivering');
	let isDelivered = $derived(row.status === 'delivered');
	let isExpired = $derived(row.status === 'expired' || (isPending && remaining <= 0));
	let isFailed = $derived(row.status === 'failed' || row.status === 'cancelled' || row.status === 'refunded');

	// ── Display amounts ──
	let ngnDisplay = $derived(row.ngn_amount_kobo / 100);
	let usdtDisplay = $derived.by(() => {
		try {
			return Number((BigInt(row.usdt_amount_wei) * 10000n) / 10n ** 18n) / 10000;
		} catch {
			return 0;
		}
	});

	// ── Status config (icon path / colors) ──
	let statusConfig = $derived.by(() => {
		if (isDelivered) return { label: 'Delivered', color: '#10b981', bg: 'rgba(16,185,129,0.1)', icon: 'M20 6L9 17l-5-5' };
		if (isFailed) return { label: row.status === 'cancelled' ? 'Cancelled' : row.status === 'refunded' ? 'Refunded' : 'Failed', color: '#f87171', bg: 'rgba(239,68,68,0.1)', icon: 'M18 6L6 18M6 6l12 12' };
		if (isExpired) return { label: 'Expired', color: '#f87171', bg: 'rgba(239,68,68,0.1)', icon: 'M12 8v5l3 3' };
		if (isInflight) return { label: row.status === 'delivering' ? 'Delivering' : 'Received', color: '#10b981', bg: 'rgba(16,185,129,0.1)', icon: 'M5 12h14M12 5l7 7-7 7' };
		// pending / quoted
		return { label: 'Awaiting Transfer', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', icon: 'M12 6v6l4 2' };
	});

	let title = $derived(
		isDelivered ? 'Buy Delivered'
			: isFailed ? `Buy ${statusConfig.label}`
			: isExpired ? 'Quote Expired'
			: isInflight ? 'Almost There'
			: 'Awaiting Your Transfer',
	);

	// Step number for the tracker — 1: awaiting, 2: received, 3: delivered.
	let step = $derived(isDelivered ? 3 : isInflight ? 2 : 1);

	function copyText(s: string) {
		try { navigator.clipboard?.writeText(s); } catch {}
	}
</script>

<ConfirmModalShell {title} {onClose}>
	<div class="text-center px-2">
		<!-- Icon -->
		<div class="w-16 h-16 rounded-full mx-auto mb-3 flex items-center justify-center" style="background: {statusConfig.bg}">
			<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={statusConfig.color} stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d={statusConfig.icon}/></svg>
		</div>

		<!-- Status label -->
		<div class="font-mono text-13 font-bold uppercase tracking-[0.1em] mb-2" style="color: {statusConfig.color};">{statusConfig.label}</div>

		<!-- Countdown for pending; otherwise no extra row -->
		{#if isPending && !isExpired}
			<div class="mt-2 mb-1">
				<span class="font-display text-4xl font-extrabold text-amber-500 tracking-[0.05em]">{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</span>
			</div>
			<div class="mb-4 px-5">
				<div class="w-full h-1 bg-surface-hover rounded-sm overflow-hidden">
					<div class="h-full rounded-sm transition-[width] duration-1000" style="width: {progressPct}%; background: linear-gradient(90deg, #f59e0b, #d97706)"></div>
				</div>
			</div>
		{:else if isExpired && isPending}
			<div class="mt-2 mb-1">
				<span class="font-display text-4xl font-extrabold text-red-400 tracking-[0.05em]">0:00</span>
			</div>
		{/if}

		<!-- Big amount + USDT sub -->
		<div class="font-display text-28 font-extrabold text-heading mb-1">₦{ngnDisplay.toLocaleString()}</div>
		{#if usdtDisplay > 0}
			<div class="font-mono text-sm font-bold text-emerald-500 mb-4">≈ {usdtDisplay.toFixed(4)} USDT</div>
		{/if}

		<!-- Step tracker (Awaiting → Received → Delivered) -->
		{#if isFailed}
			<div class="flex items-center justify-center my-4">
				<div class="flex flex-col items-center gap-1 font-mono text-3xs text-foreground">
					<div class="w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-emerald-500"></div>
					<span>Awaiting</span>
				</div>
				<div class="w-10 h-0.5 mx-1 mb-[18px] bg-red-400"></div>
				<div class="flex flex-col items-center gap-1 font-mono text-3xs text-red-400">
					<div class="w-2.5 h-2.5 rounded-full bg-red-400 border-2 border-red-400"></div>
					<span>{statusConfig.label}</span>
				</div>
			</div>
		{:else if isExpired && isPending}
			<div class="flex items-center justify-center my-4">
				<div class="flex flex-col items-center gap-1 font-mono text-3xs text-foreground">
					<div class="w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-emerald-500"></div>
					<span>Quoted</span>
				</div>
				<div class="w-10 h-0.5 mx-1 mb-[18px] bg-red-400"></div>
				<div class="flex flex-col items-center gap-1 font-mono text-3xs text-red-400">
					<div class="w-2.5 h-2.5 rounded-full bg-red-400 border-2 border-red-400"></div>
					<span>Expired</span>
				</div>
			</div>
		{:else}
			<div class="flex items-center justify-center my-4">
				<div class={'flex flex-col items-center gap-1 font-mono text-3xs transition-all duration-200 ' + (step >= 1 ? 'text-foreground ' : 'text-muted ') + (step === 1 && !isExpired ? 'text-amber-500' : '')}>
					<div class={'w-2.5 h-2.5 rounded-full border-2 transition-all duration-200 ' + (step >= 1 ? 'bg-emerald-500 border-emerald-500' : 'bg-surface-hover border-line') + (step === 1 && !isExpired ? ' !bg-amber-500 !border-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.4)]' : '')}></div>
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
	</div>

	<!-- Detail card -->
	<div class="bg-surface-input rounded-xl p-3 mb-4 text-left">
		<div class="flex justify-between items-center py-1.5 font-mono text-xs2">
			<span class="text-(--text-muted)">Reference</span>
			<span class="text-(--text-heading)">{row.reference}</span>
		</div>
		{#if row.flutterwave_va_bank_name}
			<div class="flex justify-between items-center py-1.5 font-mono text-xs2">
				<span class="text-(--text-muted)">Bank</span>
				<span class="text-(--text-heading)">{row.flutterwave_va_bank_name}</span>
			</div>
		{/if}
		{#if row.flutterwave_va_account_number}
			<div class="flex justify-between items-center py-1.5 font-mono text-xs2">
				<span class="text-(--text-muted)">Account</span>
				<button class="text-(--text-heading) hover:text-cyan-300 cursor-pointer tabular-nums" onclick={() => copyText(row.flutterwave_va_account_number!)}>{row.flutterwave_va_account_number}</button>
			</div>
		{/if}
		<div class="flex justify-between items-center py-1.5 font-mono text-xs2">
			<span class="text-(--text-muted)">Recipient</span>
			<span class="text-emerald-500 font-bold">TokenKrafter</span>
		</div>
		<div class="flex justify-between items-center py-1.5 font-mono text-xs2">
			<span class="text-(--text-muted)">Rate</span>
			<span class="text-(--text-heading) tabular-nums">1 USD = ₦{(row.rate_x100 / 100).toFixed(2)}</span>
		</div>
		{#if isDelivered || isInflight}
			<div class="flex justify-between items-center py-1.5 font-mono text-xs2">
				<span class="text-(--text-muted)">You receive</span>
				<span class="text-emerald-500 font-bold tabular-nums">{usdtDisplay.toFixed(4)} USDT</span>
			</div>
		{/if}
		{#if row.delivery_tx_hash}
			<a href="https://bscscan.com/tx/{row.delivery_tx_hash}" target="_blank" rel="noopener" class="flex justify-between items-center py-1.5 font-mono text-xs2 text-cyan-300 hover:underline">
				<span>Tx</span>
				<span class="truncate ml-2">{row.delivery_tx_hash.slice(0, 10)}…{row.delivery_tx_hash.slice(-8)}</span>
			</a>
		{/if}
		{#if row.failure_reason}
			<div class="mt-2 pt-2 border-t border-(--border-subtle) font-mono text-3xs text-red-300/80">{row.failure_reason}</div>
		{/if}
	</div>

	{#if isPending && !isExpired}
		<p class="font-mono text-3xs text-(--text-dim) m-0 leading-relaxed text-center">
			Send <span class="font-bold text-(--text-muted)">exactly ₦{ngnDisplay.toLocaleString()}</span> to the account above. The narration in your bank app doesn't matter — we match by account.
		</p>
	{/if}
</ConfirmModalShell>
