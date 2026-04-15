import { ethers } from 'ethers';

/**
 * Create a provider that prefers a WebSocket endpoint if one is configured,
 * otherwise falls back to HTTP. WS gives lower-latency reads and persistent
 * connections (no per-call handshake), at the cost of needing to reconnect
 * when the upstream drops the socket.
 *
 * The returned object exposes `provider` (whichever transport is active) and
 * `close()` for graceful shutdown. WS reconnect is handled internally — if
 * the socket dies, we open a new one and swap it in. Callers that hold a
 * reference to `current.provider` should re-read it after a reconnect, OR
 * use the `getProvider()` accessor which always returns the live provider.
 */
export interface ManagedProvider {
	getProvider(): ethers.Provider;
	close(): Promise<void>;
}

export function createManagedProvider(opts: {
	chainId: number;
	httpRpc: string;
	wsRpc?: string;
	onReconnect?: () => void;
}): ManagedProvider {
	const { chainId, httpRpc, wsRpc, onReconnect } = opts;

	if (!wsRpc) {
		const provider = new ethers.JsonRpcProvider(httpRpc, chainId, { staticNetwork: true });
		return {
			getProvider: () => provider,
			close: async () => { provider.destroy(); },
		};
	}

	let current: ethers.WebSocketProvider | ethers.JsonRpcProvider;
	let closed = false;
	let reconnectTimer: NodeJS.Timeout | null = null;

	function connect() {
		if (closed) return;
		try {
			const ws = new ethers.WebSocketProvider(wsRpc!, chainId, { staticNetwork: true });
			current = ws;

			const sock = (ws as any).websocket;
			if (sock && typeof sock.on === 'function') {
				sock.on('close', () => {
					if (closed) return;
					console.warn(`   ⚠️  WS dropped — reconnecting in 3s`);
					scheduleReconnect();
				});
				sock.on('error', (err: any) => {
					console.warn(`   ⚠️  WS error: ${err?.message?.slice(0, 60)}`);
				});
			}
			console.log(`   ✓ WebSocket connected: ${wsRpc}`);
		} catch (e: any) {
			console.warn(`   ⚠️  WS connect failed: ${e.message?.slice(0, 80)} — falling back to HTTP`);
			current = new ethers.JsonRpcProvider(httpRpc, chainId, { staticNetwork: true });
			scheduleReconnect();
		}
	}

	function scheduleReconnect() {
		if (closed || reconnectTimer) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
			onReconnect?.();
		}, 3000);
	}

	connect();

	return {
		getProvider: () => current,
		close: async () => {
			closed = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			try { (current as any).destroy?.(); } catch {}
		},
	};
}
