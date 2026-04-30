<script lang="ts">
	/**
	 * TradeHistoryPanel — unified history of off-ramp (sell USDT → bank)
	 * and on-ramp (buy USDT with bank) intents for the connected wallet.
	 *
	 * - Off-ramp data: `/api/withdrawals` + on-chain TradeRouter (status
	 *   source-of-truth) — same merge logic as the legacy
	 *   WithdrawalHistoryPanel, kept intact so the existing
	 *   confirm/cancel/status-modal flow still works.
	 * - On-ramp data: `/api/onramp/history` (DB-only — onramp_intents).
	 * - Rows are tagged with `_type` ('sell' | 'buy') and merged sorted
	 *   newest-first.
	 *
	 * Filters: All / Pending / Completed / Failed (the off-ramp's narrow
	 * statuses are mapped onto these broad buckets).
	 *
	 * Click handling:
	 *   - sell rows: emit `onselect` so the trade page can open the
	 *     existing WithdrawalStatusModal (the rich confirm/cancel flow).
	 *   - buy rows: no-op for now — buys don't have an interactive flow
	 *     after creation; the bank details are shown in the on-ramp modal
	 *     during the awaiting_payment window.
	 */
	import { ethers } from 'ethers';
	import { supabase } from '$lib/supabaseClient';
	import type { RealtimeChannel } from '@supabase/supabase-js';
	import { apiFetch } from '$lib/apiFetch';
	import { TradeRouterClient, type WithdrawalRecord } from '$lib/contracts/tradeRouter';
	import type { SupportedNetwork, DbWithdrawalRow, MergedWithdrawal } from '$lib/structure';
	import { WithdrawStatus } from '$lib/structure/tradeRouter';

	type ChainWithdrawalRecord = WithdrawalRecord & { withdraw_id: number };

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

	type Bucket = 'all' | 'pending' | 'completed' | 'failed';

	type Row =
		| { _type: 'sell'; when: number; sortKey: number; data: MergedWithdrawal; bucket: Bucket }
		| { _type: 'buy'; when: number; sortKey: number; data: OnrampHistoryRow; bucket: Bucket };

	let {
		network,
		userAddress,
		networkProviders,
		usdtDecimals = 18,
		onselect,
		onselectBuy,
	}: {
		network: SupportedNetwork | null;
		userAddress: string | null;
		networkProviders: Map<number, ethers.JsonRpcProvider>;
		usdtDecimals?: number;
		onselect: (w: MergedWithdrawal) => void;
		onselectBuy?: (o: OnrampHistoryRow) => void;
	} = $props();

	let sellRows = $state<MergedWithdrawal[]>([]);
	let buyRows = $state<OnrampHistoryRow[]>([]);
	let loading = $state(false);
	let filter = $state<Bucket>('all');
	let sellChannel: RealtimeChannel | null = null;
	let buyChannel: RealtimeChannel | null = null;

	function dbStatusLabel(status: WithdrawStatus): 'pending' | 'confirmed' | 'cancelled' {
		if (status === WithdrawStatus.Confirmed) return 'confirmed';
		if (status === WithdrawStatus.Cancelled) return 'cancelled';
		return 'pending';
	}

	function sellBucket(w: MergedWithdrawal, now: number): Bucket {
		if (w.status === WithdrawStatus.Confirmed) return 'completed';
		if (w.status === WithdrawStatus.Cancelled) return 'failed';
		if (w.expiresAt > 0 && now > w.expiresAt) return 'failed'; // timeout
		return 'pending';
	}

	/** True if a buy row is past its expiry window but still has DB
	 *  status='pending_payment' (no FLW expire-event handled). Takes
	 *  `nowSec` explicitly so the $derived block ties to the ticking
	 *  clock — badges update live as expiry passes. */
	function buyExpiredClientSide(o: OnrampHistoryRow, nowSec: number): boolean {
		if (o.status !== 'pending_payment' && o.status !== 'quoted') return false;
		try {
			return nowSec > Math.floor(new Date(o.expires_at).getTime() / 1000);
		} catch {
			return false;
		}
	}

	function buyBucket(o: OnrampHistoryRow, nowSec: number): Bucket {
		if (buyExpiredClientSide(o, nowSec)) return 'failed';
		switch (o.status) {
			case 'delivered': return 'completed';
			case 'failed':
			case 'expired':
			case 'cancelled': return 'failed';
			default: return 'pending';
		}
	}

	async function loadSells(): Promise<MergedWithdrawal[]> {
		if (!userAddress || !network) return [];
		let dbRecords: DbWithdrawalRow[] = [];
		try {
			const res = await apiFetch(`/api/withdrawals?wallet=${userAddress.toLowerCase()}`);
			if (res.ok) dbRecords = await res.json();
		} catch {}

		let chainRecords: ChainWithdrawalRecord[] = [];
		if (network.trade_router_address) {
			try {
				const provider = networkProviders.get(network.chain_id);
				if (provider) {
					const router = new TradeRouterClient(network.trade_router_address, provider);
					const { records } = await router.getUserWithdrawals(userAddress);
					chainRecords = records;
				}
			} catch {}
		}

		const usedDbIds = new Set<number>();
		const merged: MergedWithdrawal[] = [];
		for (const chain of chainRecords) {
			const db = dbRecords.find((r) =>
				!usedDbIds.has(r.id) &&
				r.withdraw_id === chain.withdraw_id &&
				r.withdraw_id != null &&
				r.withdraw_id > 0,
			);
			if (db) usedDbIds.add(db.id);
			const status = chain.status as WithdrawStatus;
			merged.push({
				id: db?.id || chain.withdraw_id,
				withdraw_id: chain.withdraw_id,
				user: chain.user,
				token: db?.token_in || '',
				grossAmount: chain.grossAmount,
				fee: chain.fee,
				netAmount: chain.netAmount,
				createdAt: chain.createdAt,
				expiresAt: chain.expiresAt,
				status,
				bankRef: chain.bankRef,
				referrer: chain.referrer,
				payment_method: db?.payment_method || 'bank',
				payment_details: db?.payment_details || {},
				chain_id: db?.chain_id || network.chain_id,
				tx_hash: db?.tx_hash || '',
				db_status: dbStatusLabel(status),
			});
		}
		return merged;
	}

	async function loadBuys(): Promise<OnrampHistoryRow[]> {
		if (!userAddress) return [];
		try {
			const res = await apiFetch(`/api/onramp/history?wallet=${userAddress.toLowerCase()}`);
			if (res.ok) return await res.json();
		} catch {}
		return [];
	}

	async function load() {
		if (!userAddress) return;
		loading = true;
		try {
			const [s, b] = await Promise.all([loadSells(), loadBuys()]);
			sellRows = s;
			buyRows = b;
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (!userAddress) return;
		load();
		if (sellChannel) supabase.removeChannel(sellChannel);
		if (buyChannel) supabase.removeChannel(buyChannel);
		sellChannel = supabase
			.channel(`trade-history-sell-${userAddress}`)
			.on('postgres_changes', {
				event: '*', schema: 'public', table: 'withdrawal_requests',
				filter: `wallet_address=eq.${userAddress.toLowerCase()}`,
			}, () => load())
			.subscribe();
		buyChannel = supabase
			.channel(`trade-history-buy-${userAddress}`)
			.on('postgres_changes', {
				event: '*', schema: 'public', table: 'onramp_intents',
				filter: `receiver=eq.${userAddress.toLowerCase()}`,
			}, () => load())
			.subscribe();
		return () => {
			if (sellChannel) supabase.removeChannel(sellChannel);
			if (buyChannel) supabase.removeChannel(buyChannel);
		};
	});

	export function refresh() { load(); }

	let nowTs = $state(Math.floor(Date.now() / 1000));
	$effect(() => {
		const id = setInterval(() => { nowTs = Math.floor(Date.now() / 1000); }, 1000);
		return () => clearInterval(id);
	});

	let allRows = $derived<Row[]>([
		...sellRows.map<Row>((w) => ({
			_type: 'sell',
			when: w.createdAt,
			sortKey: w.createdAt,
			data: w,
			bucket: sellBucket(w, nowTs),
		})),
		...buyRows.map<Row>((o) => ({
			_type: 'buy',
			when: Math.floor(new Date(o.created_at).getTime() / 1000),
			sortKey: Math.floor(new Date(o.created_at).getTime() / 1000),
			data: o,
			bucket: buyBucket(o, nowTs),
		})),
	].sort((a, b) => b.sortKey - a.sortKey));

	let filteredRows = $derived(
		filter === 'all' ? allRows : allRows.filter((r) => r.bucket === filter),
	);

	let counts = $derived({
		all: allRows.length,
		pending: allRows.filter((r) => r.bucket === 'pending').length,
		completed: allRows.filter((r) => r.bucket === 'completed').length,
		failed: allRows.filter((r) => r.bucket === 'failed').length,
	});

	const FILTERS: { id: Bucket; label: string }[] = [
		{ id: 'all', label: 'All' },
		{ id: 'pending', label: 'Pending' },
		{ id: 'completed', label: 'Completed' },
		{ id: 'failed', label: 'Failed' },
	];

	function fmtUsdt(wei: bigint | string): string {
		try {
			const v = typeof wei === 'string' ? BigInt(wei) : wei;
			return (Number((v * 10000n) / 10n ** BigInt(usdtDecimals)) / 10000).toFixed(4);
		} catch {
			return '—';
		}
	}

	function fmtNgn(kobo: number): string {
		return `₦${(kobo / 100).toLocaleString()}`;
	}

	function fmtTime(unixOrIso: number | string): string {
		try {
			const d = typeof unixOrIso === 'number'
				? new Date(unixOrIso * 1000)
				: new Date(unixOrIso);
			return d.toLocaleString();
		} catch {
			return String(unixOrIso);
		}
	}

	function buyStatusTextFor(o: OnrampHistoryRow): string {
		if (buyExpiredClientSide(o, nowTs)) return 'Expired';
		return buyStatusText(o.status);
	}

	function buyStatusText(s: string): string {
		switch (s) {
			case 'quoted': return 'Awaiting signature';
			case 'pending_payment': return 'Awaiting transfer';
			case 'payment_received': return 'Received';
			case 'delivering': return 'Delivering';
			case 'delivered': return 'Delivered';
			case 'expired': return 'Expired';
			case 'failed': return 'Failed';
			case 'cancelled': return 'Cancelled';
			case 'refunded': return 'Refunded';
			default: return s;
		}
	}

	function sellStatusText(w: MergedWithdrawal): string {
		if (w.status === WithdrawStatus.Confirmed) return 'Completed';
		if (w.status === WithdrawStatus.Cancelled) return 'Cancelled';
		if (w.expiresAt > 0 && nowTs > w.expiresAt) return 'Timeout';
		return 'Pending';
	}

	function bucketTone(b: Bucket): string {
		if (b === 'completed') return 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20';
		if (b === 'pending') return 'bg-cyan-400/10 text-cyan-300 border border-cyan-400/20';
		if (b === 'failed') return 'bg-red-500/10 text-red-300 border border-red-500/20';
		return 'bg-(--bg-surface) text-(--text-muted) border border-(--border)';
	}
</script>

<div
	id="trade-history"
	class="bg-(--bg-surface) border border-(--border) rounded-[20px] p-4 mt-3"
>
	<h3 class="syne text-15 font-bold text-(--text-heading) m-0 mb-2">Trade History</h3>

	<div class="flex gap-1 mb-2.5">
		{#each FILTERS as f}
			{@const c = counts[f.id]}
			<button
				type="button"
				class={"py-1 px-2.5 rounded-full border font-mono text-3xs cursor-pointer transition-all duration-[120ms] capitalize " +
					(filter === f.id ? "text-[#00d2ff] border-[rgba(0,210,255,0.25)] bg-[rgba(0,210,255,0.06)]" : "text-(--text-dim) border-(--border) bg-transparent hover:text-(--text-muted) hover:border-(--border-input)")}
				onclick={() => filter = f.id}
			>
				{f.label}
				{#if c > 0}
					<span class="inline-flex items-center justify-center min-w-4 h-4 py-0 px-1 rounded-lg text-xs4 font-bold bg-[rgba(0,210,255,0.1)] text-[#00d2ff] ml-[3px]">{c}</span>
				{/if}
			</button>
		{/each}
	</div>

	{#if loading && allRows.length === 0}
		<p class="font-mono text-xs2 text-(--text-muted) m-0 py-4 text-center">Loading…</p>
	{:else if filteredRows.length === 0}
		<p class="font-mono text-xs2 text-(--text-muted) m-0 py-4 text-center">No trades yet.</p>
	{:else}
		<div class="flex flex-col gap-2">
			{#each filteredRows as r (r._type + ':' + (r._type === 'sell' ? r.data.id : r.data.reference))}
				{#if r._type === 'sell'}
					{@const w = r.data}
					<button
						type="button"
						class="text-left px-3.5 py-2.5 rounded-[10px] bg-(--bg-surface-input) border border-(--border) hover:border-(--border-input) cursor-pointer transition-colors"
						onclick={() => onselect(w)}
					>
						<div class="flex items-center justify-between gap-2">
							<div class="min-w-0">
								<div class="flex items-center gap-1.5">
									<span class="px-1.5 py-px rounded font-mono text-3xs bg-emerald-500/10 text-emerald-300 border border-emerald-500/15">SELL</span>
									<span class="font-numeric text-sm font-bold text-(--text-heading) tabular-nums">{fmtUsdt(w.grossAmount)} USDT</span>
								</div>
								<span class="block font-mono text-3xs text-(--text-dim) mt-0.5 truncate">#{w.withdraw_id} · {fmtTime(w.createdAt)}</span>
							</div>
							<span class={'shrink-0 px-2 py-1 rounded-md font-mono text-3xs ' + bucketTone(r.bucket)}>
								{sellStatusText(w)}
							</span>
						</div>
					</button>
				{:else}
					{@const o = r.data}
					<button
						type="button"
						class="text-left px-3.5 py-2.5 rounded-[10px] bg-(--bg-surface-input) border border-(--border) hover:border-(--border-input) cursor-pointer transition-colors w-full"
						onclick={() => onselectBuy?.(o)}
					>
						<div class="flex items-center justify-between gap-2">
							<div class="min-w-0">
								<div class="flex items-center gap-1.5">
									<span class="px-1.5 py-px rounded font-mono text-3xs bg-cyan-400/10 text-cyan-300 border border-cyan-400/15">BUY</span>
									<span class="font-numeric text-sm font-bold text-(--text-heading) tabular-nums">{fmtNgn(o.ngn_amount_kobo)} → {fmtUsdt(o.usdt_amount_wei)} USDT</span>
								</div>
								<span class="block font-mono text-3xs text-(--text-dim) mt-0.5 truncate">{o.reference} · {fmtTime(o.created_at)}</span>
							</div>
							<span class={'shrink-0 px-2 py-1 rounded-md font-mono text-3xs ' + bucketTone(r.bucket)}>
								{buyStatusTextFor(o)}
							</span>
						</div>
						{#if o.delivery_tx_hash}
							<span class="block mt-1 font-mono text-3xs text-cyan-300 truncate">{o.delivery_tx_hash.slice(0, 10)}…{o.delivery_tx_hash.slice(-8)}</span>
						{:else if o.failure_reason}
							<p class="mt-1 font-mono text-3xs text-red-300/80 m-0">{o.failure_reason}</p>
						{/if}
					</button>
				{/if}
			{/each}
		</div>
	{/if}
</div>
