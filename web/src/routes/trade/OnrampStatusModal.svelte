<script lang="ts">
	/**
	 * Read-only status modal for an on-ramp intent. Shown when the user
	 * clicks a "BUY" row in TradeHistoryPanel. If the intent is still
	 * awaiting payment, the bank-transfer details are shown inline so
	 * the user can resume the transfer; otherwise we show outcome data.
	 */
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

	function fmtUsdt(wei: string): string {
		try {
			return (Number((BigInt(wei) * 10000n) / 10n ** 18n) / 10000).toFixed(4);
		} catch {
			return '—';
		}
	}

	function fmtNgn(kobo: number): string {
		return `₦${(kobo / 100).toLocaleString()}`;
	}

	function fmtTime(iso: string | null): string {
		if (!iso) return '—';
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}

	function copyText(s: string) {
		try { navigator.clipboard?.writeText(s); } catch {}
	}

	let title = $derived(
		row.status === 'delivered' ? 'Buy delivered'
			: row.status === 'failed' || row.status === 'expired' || row.status === 'cancelled' ? 'Buy ' + row.status
			: row.status === 'pending_payment' ? 'Awaiting your transfer'
			: 'Buy in progress',
	);

	let isAwaitingPayment = $derived(row.status === 'pending_payment');

	let statusTone = $derived(
		row.status === 'delivered' ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
			: row.status === 'failed' ? 'bg-red-500/10 text-red-300 border border-red-500/20'
			: 'bg-cyan-400/10 text-cyan-300 border border-cyan-400/20',
	);

	function statusText(s: string): string {
		switch (s) {
			case 'quoted': return 'Awaiting signature';
			case 'pending_payment': return 'Awaiting transfer';
			case 'payment_received': return 'Payment received';
			case 'delivering': return 'Delivering USDT';
			case 'delivered': return 'Delivered';
			case 'expired': return 'Expired';
			case 'failed': return 'Failed';
			case 'cancelled': return 'Cancelled';
			case 'refunded': return 'Refunded';
			default: return s;
		}
	}
</script>

<ConfirmModalShell {title} {onClose}>
	<div class="flex flex-col gap-3">
		<!-- Pay / Receive summary -->
		<div class="flex flex-col bg-(--bg-surface-input) rounded-xl overflow-hidden">
			<div class="px-3.5 py-2.5">
				<span class="block font-mono text-xs4 font-semibold uppercase tracking-[0.05em] text-(--text-muted) mb-0.5">Pay</span>
				<span class="block font-[Rajdhani,sans-serif] text-22 font-bold text-(--text-heading) leading-[1.3] tabular-nums">{fmtNgn(row.ngn_amount_kobo)}</span>
			</div>
			<div class="h-px bg-(--border)"></div>
			<div class="px-3.5 py-2.5">
				<span class="block font-mono text-xs4 font-semibold uppercase tracking-[0.05em] text-(--text-muted) mb-0.5">Receive</span>
				<span class="block font-[Rajdhani,sans-serif] text-22 font-bold text-[#10b981] leading-[1.3] tabular-nums">{fmtUsdt(row.usdt_amount_wei)} <span class="text-sm text-(--text-muted) font-semibold">USDT</span></span>
			</div>
		</div>

		<!-- Status pill + metadata -->
		<div class="px-3.5 py-3 rounded-xl bg-(--bg-surface) border border-(--border) flex flex-col gap-2">
			<div class="flex justify-between items-center">
				<span class="font-mono text-xs2 text-(--text-muted)">Status</span>
				<span class={'px-2 py-0.5 rounded-md font-mono text-3xs ' + statusTone}>{statusText(row.status)}</span>
			</div>
			<div class="flex justify-between items-center">
				<span class="font-mono text-xs2 text-(--text-muted)">Reference</span>
				<span class="font-mono text-xs2 text-(--text-heading) truncate">{row.reference}</span>
			</div>
			<div class="flex justify-between items-center">
				<span class="font-mono text-xs2 text-(--text-muted)">Locked rate</span>
				<span class="font-numeric text-xs2 text-(--text-heading) tabular-nums">₦{(row.rate_x100 / 100).toFixed(2)} / $1</span>
			</div>
			<div class="flex justify-between items-center">
				<span class="font-mono text-xs2 text-(--text-muted)">Created</span>
				<span class="font-mono text-xs2 text-(--text-heading)">{fmtTime(row.created_at)}</span>
			</div>
			{#if row.paid_at}
				<div class="flex justify-between items-center">
					<span class="font-mono text-xs2 text-(--text-muted)">Paid</span>
					<span class="font-mono text-xs2 text-(--text-heading)">{fmtTime(row.paid_at)}</span>
				</div>
			{/if}
			{#if row.delivered_at}
				<div class="flex justify-between items-center">
					<span class="font-mono text-xs2 text-(--text-muted)">Delivered</span>
					<span class="font-mono text-xs2 text-(--text-heading)">{fmtTime(row.delivered_at)}</span>
				</div>
			{/if}
		</div>

		{#if isAwaitingPayment && row.flutterwave_va_account_number}
			<!-- Bank details — same structure as the live on-ramp modal -->
			<div class="rounded-xl border border-cyan-400/15 bg-cyan-400/[0.04] p-4 flex flex-col gap-3">
				<div>
					<span class="block font-mono text-xs2 text-(--text-muted)">Send exactly</span>
					<span class="block font-numeric text-22 font-bold text-(--text-heading) tabular-nums">{fmtNgn(row.ngn_amount_kobo)}</span>
				</div>
				<div class="flex flex-col gap-2">
					{#if row.flutterwave_va_bank_name}
						<div class="px-3 py-2 rounded-[10px] bg-(--bg-surface) border border-(--border)">
							<span class="block font-mono text-3xs text-(--text-muted) uppercase tracking-wide">Bank</span>
							<span class="block font-display text-sm font-bold text-(--text-heading) truncate">{row.flutterwave_va_bank_name}</span>
						</div>
					{/if}
					<div class="flex items-center justify-between gap-2 px-3 py-2 rounded-[10px] bg-(--bg-surface) border border-(--border)">
						<div class="min-w-0">
							<span class="block font-mono text-3xs text-(--text-muted) uppercase tracking-wide">Account number</span>
							<span class="block font-numeric text-base font-bold text-(--text-heading) tabular-nums">{row.flutterwave_va_account_number}</span>
						</div>
						<button class="shrink-0 px-2.5 py-1 rounded-md bg-(--bg-surface-hover) border border-(--border) text-(--text-muted) font-mono text-3xs hover:text-cyan-300" onclick={() => copyText(row.flutterwave_va_account_number!)}>Copy</button>
					</div>
					<div class="flex items-center justify-between gap-2 px-3 py-2 rounded-[10px] bg-(--bg-surface) border border-(--border)">
						<div class="min-w-0">
							<span class="block font-mono text-3xs text-(--text-muted) uppercase tracking-wide">Reference</span>
							<span class="block font-mono text-xs2 text-(--text-heading) truncate">{row.reference}</span>
						</div>
						<button class="shrink-0 px-2.5 py-1 rounded-md bg-(--bg-surface-hover) border border-(--border) text-(--text-muted) font-mono text-3xs hover:text-cyan-300" onclick={() => copyText(row.reference)}>Copy</button>
					</div>
				</div>
				<p class="font-mono text-3xs text-(--text-dim) m-0 leading-relaxed">Account expires {fmtTime(row.expires_at)}. Send the exact amount once.</p>
			</div>
		{:else if row.delivery_tx_hash}
			<a href="https://bscscan.com/tx/{row.delivery_tx_hash}" target="_blank" rel="noopener" class="px-3.5 py-2 rounded-xl bg-(--bg-surface) border border-(--border) font-mono text-xs2 text-cyan-300 hover:underline truncate text-center">
				View tx: {row.delivery_tx_hash.slice(0, 10)}…{row.delivery_tx_hash.slice(-8)}
			</a>
		{:else if row.failure_reason}
			<div class="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-3">
				<p class="font-mono text-xs2 text-red-300 m-0">{row.failure_reason}</p>
			</div>
		{/if}
	</div>
</ConfirmModalShell>
