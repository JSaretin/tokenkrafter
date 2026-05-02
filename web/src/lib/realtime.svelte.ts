/**
 * Supabase Realtime subscription manager.
 *
 * One channel, multi-consumer. The root layout calls connect() once
 * on mount and pages observe state via Svelte runes — no per-page
 * channel.subscribe() / removeChannel() boilerplate, no duplicate WS
 * subscriptions, and the multi-page `/explore` ↔ `/launchpad`
 * navigation doesn't churn.
 *
 * Tables covered:
 *   recent_transactions  — INSERT (transactions stream, capped)
 *   created_tokens       — INSERT + UPDATE (latest payload + seq)
 *   launches             — INSERT + UPDATE (latest payload + seq)
 *
 * Pages consume by holding their own reactive state (e.g. `tokens`)
 * and running `$effect` on the matching `lastTokenInsert` /
 * `lastTokenUpdate` etc. — that gives each page its own filter/order
 * while sharing the WS connection.
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

/** Generic event payload — pages observe { seq, row } pairs. seq is
 *  monotonically increasing so $effect fires even if the same row
 *  arrives twice (e.g. two UPDATEs hit the same column values). */
export interface RtEvent<T = any> {
	seq: number;
	row: T;
}

class RealtimeStore {
	transactions: LiveTransaction[] = $state([]);
	launchUpdates: Map<string, LiveLaunchUpdate> = $state(new Map());

	// Latest INSERT/UPDATE payloads per table — pages $effect on these.
	lastTokenInsert: RtEvent | null = $state(null);
	lastTokenUpdate: RtEvent | null = $state(null);
	lastLaunchInsert: RtEvent | null = $state(null);
	// `lastLaunchUpdate` is implicit in launchUpdates above — kept for
	// symmetry so pages have one observation pattern.
	lastLaunchUpdate: RtEvent | null = $state(null);

	connected = $state(false);

	private channel: RealtimeChannel | null = null;
	private maxTransactions = 50;
	private seq = 0;
	private nextSeq() {
		this.seq += 1;
		return this.seq;
	}

	async connect() {
		if (this.connected || this.channel) return;

		// Load initial transaction stream (other tables hydrate from SSR).
		try {
			const { data } = await supabase
				.from('recent_transactions')
				.select('*')
				.order('created_at', { ascending: false })
				.limit(this.maxTransactions);
			if (data) this.transactions = data;
		} catch {}

		this.channel = supabase
			.channel('platform-realtime')
			.on(
				'postgres_changes',
				{ event: 'INSERT', schema: 'public', table: 'recent_transactions' },
				(payload) => {
					const tx = payload.new as LiveTransaction;
					this.transactions = [tx, ...this.transactions].slice(0, this.maxTransactions);
				},
			)
			.on(
				'postgres_changes',
				{ event: 'INSERT', schema: 'public', table: 'created_tokens' },
				(payload) => {
					this.lastTokenInsert = { seq: this.nextSeq(), row: payload.new };
				},
			)
			.on(
				'postgres_changes',
				{ event: 'UPDATE', schema: 'public', table: 'created_tokens' },
				(payload) => {
					this.lastTokenUpdate = { seq: this.nextSeq(), row: payload.new };
				},
			)
			.on(
				'postgres_changes',
				{ event: 'INSERT', schema: 'public', table: 'launches' },
				(payload) => {
					this.lastLaunchInsert = { seq: this.nextSeq(), row: payload.new };
				},
			)
			.on(
				'postgres_changes',
				{ event: 'UPDATE', schema: 'public', table: 'launches' },
				(payload) => {
					const row = payload.new as any;
					this.lastLaunchUpdate = { seq: this.nextSeq(), row };

					// Legacy compact map kept for MarketFlow (which only
					// cares about progress fields). Skip when nothing in
					// the watched columns changed.
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
						current_price: row.current_price,
					};
					const newMap = new Map(this.launchUpdates);
					newMap.set(row.address, update);
					this.launchUpdates = newMap;
				},
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
