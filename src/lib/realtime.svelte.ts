/**
 * Supabase Realtime subscription manager
 * Provides reactive stores for live platform data
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
	// Live transaction feed (most recent first)
	transactions: LiveTransaction[] = $state([]);

	// Launch updates (keyed by address)
	launchUpdates: Map<string, LiveLaunchUpdate> = $state(new Map());

	// Connection state
	connected = $state(false);

	// Stats
	activeBuyers = $state(0);
	usersOnline = $state(0);

	private channels: RealtimeChannel[] = [];
	private maxTransactions = 50;

	async connect() {
		if (this.connected) return;

		// Load initial recent transactions
		try {
			const { data } = await supabase
				.from('recent_transactions')
				.select('*')
				.order('created_at', { ascending: false })
				.limit(this.maxTransactions);
			if (data) this.transactions = data;
		} catch {}

		// Subscribe to new transactions
		const txChannel = supabase
			.channel('public:recent_transactions')
			.on(
				'postgres_changes',
				{ event: 'INSERT', schema: 'public', table: 'recent_transactions' },
				(payload) => {
					const tx = payload.new as LiveTransaction;
					this.transactions = [tx, ...this.transactions].slice(0, this.maxTransactions);
				}
			)
			.subscribe((status) => {
				this.connected = status === 'SUBSCRIBED';
			});

		this.channels.push(txChannel);

		// Subscribe to launch updates (state, raised, price changes)
		const launchChannel = supabase
			.channel('public:launches')
			.on(
				'postgres_changes',
				{ event: 'UPDATE', schema: 'public', table: 'launches' },
				(payload) => {
					const row = payload.new as any;
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
			.subscribe();

		this.channels.push(launchChannel);

		// Subscribe to visitor count changes
		const visitorChannel = supabase
			.channel('public:site_visitors')
			.on(
				'postgres_changes',
				{ event: 'UPDATE', schema: 'public', table: 'site_visitors' },
				(payload) => {
					const row = payload.new as any;
					this.usersOnline = row.total_visitors || 0;
					this.activeBuyers = row.investing || 0;
				}
			)
			.subscribe();

		this.channels.push(visitorChannel);
	}

	disconnect() {
		for (const ch of this.channels) {
			supabase.removeChannel(ch);
		}
		this.channels = [];
		this.connected = false;
	}
}

export const realtime = new RealtimeStore();
