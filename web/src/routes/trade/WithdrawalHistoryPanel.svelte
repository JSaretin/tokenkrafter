<script lang="ts">
	import { ethers } from 'ethers';
	import { supabase } from '$lib/supabaseClient';
	import type { RealtimeChannel } from '@supabase/supabase-js';
	import { apiFetch } from '$lib/apiFetch';
	import { TradeRouterClient, type WithdrawalRecord } from '$lib/contracts/tradeRouter';
	import type { SupportedNetwork, DbWithdrawalRow, MergedWithdrawal } from '$lib/structure';
	import { WithdrawStatus } from '$lib/structure/tradeRouter';
	import { t } from '$lib/i18n';
	import HistoryFilterBar, { type HistoryFilter, type FilterCounts } from './HistoryFilterBar.svelte';
	import HistoryList from './HistoryList.svelte';

	type ChainWithdrawalRecord = WithdrawalRecord & { withdraw_id: number };

	let {
		network,
		userAddress,
		networkProviders,
		usdtDecimals = 18,
		onselect,
	}: {
		network: SupportedNetwork | null;
		userAddress: string | null;
		networkProviders: Map<number, ethers.JsonRpcProvider>;
		usdtDecimals?: number;
		onselect: (w: MergedWithdrawal) => void;
	} = $props();

	let withdrawals = $state<MergedWithdrawal[]>([]);
	let loading = $state(false);
	let filter = $state<HistoryFilter>('all');
	let channel: RealtimeChannel | null = null;

	function dbStatusLabel(status: WithdrawStatus): 'pending' | 'confirmed' | 'cancelled' {
		if (status === WithdrawStatus.Confirmed) return 'confirmed';
		if (status === WithdrawStatus.Cancelled) return 'cancelled';
		return 'pending';
	}

	async function loadHistory() {
		if (!userAddress || !network) return;
		loading = true;
		try {
			// 1. DB records (payment details + status)
			let dbRecords: DbWithdrawalRow[] = [];
			try {
				const res = await apiFetch(`/api/withdrawals?wallet=${userAddress.toLowerCase()}`);
				if (res.ok) dbRecords = await res.json();
			} catch {}

			// 2. On-chain records (source of truth)
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

			// 3. Merge: on-chain is source of truth, enrich with DB data
			const usedDbIds = new Set<number>();
			const merged: MergedWithdrawal[] = [];
			for (const chain of chainRecords) {
				const db = dbRecords.find(r =>
					!usedDbIds.has(r.id) &&
					r.withdraw_id === chain.withdraw_id &&
					r.withdraw_id != null &&
					r.withdraw_id > 0
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
			withdrawals = merged;
		} catch (e) {
			console.error('loadHistory error:', e);
			withdrawals = [];
		} finally {
			loading = false;
		}
	}

	// Load + subscribe on mount / when user changes
	$effect(() => {
		if (!userAddress) return;
		loadHistory();
		if (channel) supabase.removeChannel(channel);
		channel = supabase
			.channel(`trade-history-${userAddress}`)
			.on('postgres_changes', {
				event: '*', schema: 'public', table: 'withdrawal_requests',
				filter: `wallet_address=eq.${userAddress.toLowerCase()}`,
			}, () => loadHistory())
			.subscribe();

		return () => {
			if (channel) supabase.removeChannel(channel);
		};
	});

	/** Public method: trigger a reload (e.g. after cancel/confirm) */
	export function refresh() { loadHistory(); }

	let nowTs = $state(Math.floor(Date.now() / 1000));
	$effect(() => {
		const id = setInterval(() => { nowTs = Math.floor(Date.now() / 1000); }, 1000);
		return () => clearInterval(id);
	});

	let counts = $derived<FilterCounts>({
		all: withdrawals.length,
		pending: withdrawals.filter(w => w.status === 0 && !(w.expiresAt > 0 && nowTs > w.expiresAt)).length,
		completed: withdrawals.filter(w => w.status === 1).length,
		timeout: withdrawals.filter(w => w.status === 0 && w.expiresAt > 0 && nowTs > w.expiresAt).length,
		cancelled: withdrawals.filter(w => w.status === 2).length,
	});
</script>

<div
	id="trade-history"
	class="bg-(--bg-surface) border border-(--border) rounded-[20px] p-4 mt-3"
>
	<h3 class="syne text-[15px] font-bold text-(--text-heading) m-0 mb-2">{$t('trade.withdrawalHistory')}</h3>
	<HistoryFilterBar bind:filter {counts} />
	<HistoryList {withdrawals} {filter} {loading} {usdtDecimals} {onselect} />
</div>
