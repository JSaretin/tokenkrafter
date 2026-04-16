/**
 * Supabase Realtime subscription manager
 * Single channel, chained .on() handlers, one .subscribe()
 */
import { supabase } from '$lib/supabaseClient';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface LiveTransaction {
	id: number;
	chain_id: number;
	launch_address: string;
	token_symbol: string;
	token_name: string;
	buyer: string;
	tokens_amount: string;
	base_amount: string;
	base_symbol: string;
	base_decimals: number;
	token_decimals: number;
	tx_hash: string;
	created_at: string;
}

export interface LiveLaunchUpdate {
	address: string;
	chain_id: number;
	state: number;
	total_base_raised: string;
	tokens_sold: string;
	current_price: string;
}

class RealtimeStore {
	transactions: LiveTransaction[] = $state([]);
	launchUpdates: Map<string, LiveLaunchUpdate> = $state(new Map());
	connected = $state(false);

	private channel: RealtimeChannel | null = null;
	private maxTransactions = 50;

	async connect() {
		if (this.connected || this.channel) return;

		// Load initial data
		try {
			const { data } = await supabase
				.from('recent_transactions')
				.select('*')
				.order('created_at', { ascending: false })
				.limit(this.maxTransactions);
			if (data) this.transactions = data;
		} catch {}

		// Single channel, chained handlers, one subscribe
		this.channel = supabase
			.channel('platform-realtime')
			.on(
				'postgres_changes',
				{ event: 'INSERT', schema: 'public', table: 'recent_transactions' },
				(payload) => {
					const tx = payload.new as LiveTransaction;
					this.transactions = [tx, ...this.transactions].slice(0, this.maxTransactions);
				}
			)
			.on(
				'postgres_changes',
				{ event: 'UPDATE', schema: 'public', table: 'launches' },
				(payload) => {
					const row = payload.new as any;
					const existing = this.launchUpdates.get(row.address);
					if (existing &&
						existing.state === row.state &&
						existing.total_base_raised === row.total_base_raised &&
						existing.tokens_sold === row.tokens_sold &&
						existing.current_price === row.current_price) return;

					const update: LiveLaunchUpdate = {
						address: row.address,
						chain_id: row.chain_id,
						state: row.state,
						total_base_raised: row.total_base_raised,
						tokens_sold: row.tokens_sold,
						current_price: row.current_price
					};
					const newMap = new Map(this.launchUpdates);
					newMap.set(row.address, update);
					this.launchUpdates = newMap;
				}
			)
			.subscribe((status) => {
				this.connected = status === 'SUBSCRIBED';
			});
	}

	disconnect() {
		if (this.channel) {
			supabase.removeChannel(this.channel);
			this.channel = null;
		}
		this.connected = false;
	}
}

export const realtime = new RealtimeStore();
