/**
 * Per-chain on-chain event subscription manager.
 *
 * Opens one ethers.WebSocketProvider per enabled chain (using the
 * public `ws_rpc` from platform_config — never `daemon_rpc`, which is
 * a private/MEV-protected endpoint we keep out of browsers). Pages
 * subscribe to filtered logs via subscribe(chainId, filter, cb) and
 * get an unsubscribe function back.
 *
 * Why a second WS layer alongside Supabase realtime:
 *
 *   Supabase realtime  : chain → ws-indexer (daemon) → DB → push
 *                        Latency ~4–6s, depends on indexer uptime.
 *   chainRealtime (this): chain WS → browser directly
 *                        Latency ~3s. Independent of our backend, so
 *                        a stalled indexer doesn't black out user UX.
 *
 * Use this for hot-path events that benefit from sub-second feedback:
 *   - Launchpad TokenBought / Graduated (active launch users)
 *   - TradeRouter WithdrawConfirmed (a user watching their withdrawal)
 *   - Token taxes / trading-enabled flips on a token detail page
 *
 * Use Supabase realtime for cross-cutting list views (e.g. /explore
 * "new tokens", /launchpad "new launches") — the indexer aggregates
 * across all chains into one DB stream there's no point duplicating.
 */
import { ethers } from 'ethers';
import type { SupportedNetwork } from '$lib/structure';

export type LogHandler = (log: ethers.Log) => void;

interface ChainConn {
	chainId: number;
	wsRpc: string;
	provider: ethers.WebSocketProvider | null;
	closed: boolean;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	// Active subscriptions — re-applied on reconnect.
	subs: Map<string, { filter: ethers.EventFilter; cb: LogHandler }>;
}

class ChainRealtimeStore {
	connected = $state<Record<number, boolean>>({});

	private conns = new Map<number, ChainConn>();
	private subSeq = 0;

	connect(networks: SupportedNetwork[]) {
		for (const net of networks) {
			if (this.conns.has(net.chain_id)) continue;
			if (!net.ws_rpc) continue; // chain has no public WS — skip
			const conn: ChainConn = {
				chainId: net.chain_id,
				wsRpc: net.ws_rpc,
				provider: null,
				closed: false,
				reconnectTimer: null,
				subs: new Map(),
			};
			this.conns.set(net.chain_id, conn);
			this.openConn(conn);
		}
	}

	private openConn(conn: ChainConn) {
		if (conn.closed) return;
		try {
			conn.provider = new ethers.WebSocketProvider(
				() => new WebSocket(conn.wsRpc) as any,
				conn.chainId,
				{ staticNetwork: true },
			);
			// ethers' WebSocketLike type doesn't expose addEventListener,
			// but the underlying browser WebSocket does — cast to any.
			const ws = conn.provider.websocket as any;
			ws.addEventListener?.('close', () => {
				if (conn.closed) return;
				this.connected = { ...this.connected, [conn.chainId]: false };
				conn.provider = null;
				this.scheduleReconnect(conn);
			});
			ws.addEventListener?.('error', () => {
				/* close handler will fire after */
			});

			// Re-apply active subs after a fresh connection.
			for (const { filter, cb } of conn.subs.values()) {
				try { conn.provider.on(filter as any, cb); } catch {}
			}
			this.connected = { ...this.connected, [conn.chainId]: true };
		} catch {
			conn.provider = null;
			this.scheduleReconnect(conn);
		}
	}

	private scheduleReconnect(conn: ChainConn) {
		if (conn.closed || conn.reconnectTimer) return;
		conn.reconnectTimer = setTimeout(() => {
			conn.reconnectTimer = null;
			this.openConn(conn);
		}, 3000);
	}

	/** Subscribe to filtered logs on a chain. Returns an unsubscribe fn.
	 *  Safe to call before connect() — the sub is queued and applied
	 *  when the WS comes up. Same for reconnects. */
	subscribe(chainId: number, filter: ethers.EventFilter, cb: LogHandler): () => void {
		let conn = this.conns.get(chainId);
		if (!conn) {
			// Page subscribed before connect() saw this chain — make a
			// stub conn that openConn() can fill in once connect() runs.
			// Edge case: caller subscribed for a chain that has no
			// ws_rpc; connect() won't open it, sub stays parked.
			conn = {
				chainId,
				wsRpc: '',
				provider: null,
				closed: false,
				reconnectTimer: null,
				subs: new Map(),
			};
			this.conns.set(chainId, conn);
		}
		const id = `s${++this.subSeq}`;
		conn.subs.set(id, { filter, cb });
		if (conn.provider) {
			try { conn.provider.on(filter as any, cb); } catch {}
		}
		return () => {
			const c = this.conns.get(chainId);
			if (!c) return;
			const sub = c.subs.get(id);
			c.subs.delete(id);
			if (sub && c.provider) {
				try { c.provider.off(filter as any, cb); } catch {}
			}
		};
	}

	disconnect() {
		for (const conn of this.conns.values()) {
			conn.closed = true;
			if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
			if (conn.provider) {
				try { conn.provider.removeAllListeners(); } catch {}
				try { conn.provider.destroy(); } catch {}
			}
		}
		this.conns.clear();
		this.connected = {};
	}
}

export const chainRealtime = new ChainRealtimeStore();
