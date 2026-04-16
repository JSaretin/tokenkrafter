import { ethers } from 'ethers';
import type { SupportedNetwork } from './structure';

export interface EventSubscription {
	unsubscribe(): void;
}

export interface WsProviderManager {
	getWsProvider(chainId: number): ethers.WebSocketProvider | null;
	getHttpProvider(chainId: number): ethers.JsonRpcProvider | null;
	subscribeLogs(
		chainId: number,
		filter: ethers.EventFilter,
		callback: (log: ethers.Log) => void,
	): EventSubscription;
	subscribeBlocks(
		chainId: number,
		callback: (blockNumber: number) => void,
	): EventSubscription;
	close(): void;
}

interface ChainEntry {
	chainId: number;
	wsRpc: string;
	httpRpc: string;
	ws: ethers.WebSocketProvider | null;
	http: ethers.JsonRpcProvider;
	closed: boolean;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	listeners: Set<{ type: 'logs'; filter: ethers.EventFilter; cb: (log: ethers.Log) => void }
		| { type: 'block'; cb: (blockNumber: number) => void }>;
}

const RECONNECT_DELAY = 3000;

function connectWs(entry: ChainEntry) {
	if (entry.closed || !entry.wsRpc) return;
	try {
		const ws = new ethers.WebSocketProvider(entry.wsRpc, entry.chainId, { staticNetwork: true });
		entry.ws = ws;

		const sock = (ws as any).websocket as WebSocket | undefined;
		if (sock) {
			sock.addEventListener('close', () => {
				if (entry.closed) return;
				entry.ws = null;
				scheduleReconnect(entry);
			});
			sock.addEventListener('error', () => {
				if (entry.closed) return;
			});
		}

		resubscribe(entry);
	} catch {
		entry.ws = null;
		scheduleReconnect(entry);
	}
}

function scheduleReconnect(entry: ChainEntry) {
	if (entry.closed || entry.reconnectTimer) return;
	entry.reconnectTimer = setTimeout(() => {
		entry.reconnectTimer = null;
		connectWs(entry);
	}, RECONNECT_DELAY);
}

function resubscribe(entry: ChainEntry) {
	const ws = entry.ws;
	if (!ws) return;
	for (const listener of entry.listeners) {
		if (listener.type === 'logs') {
			ws.on(listener.filter, listener.cb);
		} else {
			ws.on('block', listener.cb);
		}
	}
}

export function createWsProviderManager(
	networks: SupportedNetwork[],
	httpProviders: Map<number, ethers.JsonRpcProvider>,
): WsProviderManager {
	const entries = new Map<number, ChainEntry>();

	for (const net of networks) {
		if (!net.ws_rpc) continue;
		const http = httpProviders.get(net.chain_id);
		if (!http) continue;

		const entry: ChainEntry = {
			chainId: net.chain_id,
			wsRpc: net.ws_rpc,
			httpRpc: net.rpc,
			ws: null,
			http,
			closed: false,
			reconnectTimer: null,
			listeners: new Set(),
		};
		entries.set(net.chain_id, entry);
		connectWs(entry);
	}

	return {
		getWsProvider(chainId) {
			return entries.get(chainId)?.ws ?? null;
		},

		getHttpProvider(chainId) {
			return entries.get(chainId)?.http ?? httpProviders.get(chainId) ?? null;
		},

		subscribeLogs(chainId, filter, callback) {
			const entry = entries.get(chainId);
			if (!entry) {
				return { unsubscribe() {} };
			}

			const listener = { type: 'logs' as const, filter, cb: callback };
			entry.listeners.add(listener);

			if (entry.ws) {
				entry.ws.on(filter, callback);
			}

			return {
				unsubscribe() {
					entry.listeners.delete(listener);
					if (entry.ws) {
						entry.ws.off(filter, callback);
					}
				},
			};
		},

		subscribeBlocks(chainId, callback) {
			const entry = entries.get(chainId);
			if (!entry) {
				return { unsubscribe() {} };
			}

			const listener = { type: 'block' as const, cb: callback };
			entry.listeners.add(listener);

			if (entry.ws) {
				entry.ws.on('block', callback);
			}

			return {
				unsubscribe() {
					entry.listeners.delete(listener);
					if (entry.ws) {
						entry.ws.off('block', callback);
					}
				},
			};
		},

		close() {
			for (const entry of entries.values()) {
				entry.closed = true;
				if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
				try { entry.ws?.destroy(); } catch {}
				entry.ws = null;
				entry.listeners.clear();
			}
			entries.clear();
		},
	};
}

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

export function transferFilter(userAddress: string, tokenAddresses?: string[]): ethers.EventFilter {
	const paddedUser = ethers.zeroPadValue(userAddress, 32);
	return {
		address: tokenAddresses?.length === 1 ? tokenAddresses[0] : undefined,
		topics: [
			TRANSFER_TOPIC,
			null,
			paddedUser,
		],
	};
}

export function transferFromFilter(userAddress: string, tokenAddresses?: string[]): ethers.EventFilter {
	const paddedUser = ethers.zeroPadValue(userAddress, 32);
	return {
		address: tokenAddresses?.length === 1 ? tokenAddresses[0] : undefined,
		topics: [
			TRANSFER_TOPIC,
			paddedUser,
			null,
		],
	};
}
