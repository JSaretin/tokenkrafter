import { ethers } from 'ethers';

/**
 * Create a provider that prefers a WebSocket endpoint if one is configured,
 * otherwise falls back to HTTP.
 *
 * Uses bun's native globalThis.WebSocket via a factory function passed to
 * ethers — this bypasses ethers' internal `ws` npm package import which
 * goes through bun's broken node:http polyfill (throws "Unexpected server
 * response: 101" on the upgrade handshake).
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
			// Factory function: returns bun's native WebSocket, NOT the `ws`
			// npm package. Bun's native WebSocket handles the HTTP 101 upgrade
			// correctly; ethers' default path goes through `ws` → node:http
			// which bun's polyfill breaks.
			const provider = new ethers.WebSocketProvider(
				() => new WebSocket(wsRpc!) as any,
				chainId,
				{ staticNetwork: true },
			);
			current = provider;

			// Detect close via the underlying socket. ethers v6 exposes
			// .websocket which is the raw WebSocket instance.
			const sock = provider.websocket;
			sock.addEventListener('close', () => {
				if (closed) return;
				console.warn(`   ⚠️  WS dropped — reconnecting in 3s`);
				scheduleReconnect();
			});
			sock.addEventListener('error', (evt: any) => {
				if (closed) return;
				const msg = evt?.message || evt?.error?.message || 'unknown';
				console.warn(`   ⚠️  WS error: ${String(msg).slice(0, 60)}`);
			});

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
			try { (current as any).destroy?.(); } catch {}
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
