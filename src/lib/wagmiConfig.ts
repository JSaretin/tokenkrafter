import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';

let modal: any = null;

/**
 * Patch WebSocket to route WalletConnect relay traffic through a custom proxy.
 * This allows users in regions where relay.walletconnect.com is blocked
 * to connect without a VPN.
 */
function patchWebSocketRelay() {
	const relayProxy = env.PUBLIC_WC_RELAY_PROXY;
	if (!relayProxy) return;

	const OriginalWebSocket = window.WebSocket;
	const PatchedWebSocket = function (url: string | URL, protocols?: string | string[]) {
		const urlStr = typeof url === 'string' ? url : url.toString();
		if (urlStr.includes('relay.walletconnect.com')) {
			url = urlStr.replace('relay.walletconnect.com', relayProxy);
		}
		return new OriginalWebSocket(url, protocols);
	} as unknown as typeof WebSocket;
	PatchedWebSocket.prototype = OriginalWebSocket.prototype;
	PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
	PatchedWebSocket.OPEN = OriginalWebSocket.OPEN;
	PatchedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
	PatchedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
	window.WebSocket = PatchedWebSocket;
}

export async function initAppKit() {
	if (modal || !browser) return modal;

	const projectId = env.PUBLIC_WALLET_CONNECT_PROJECT_ID;
	if (!projectId) {
		console.warn('Missing PUBLIC_WALLET_CONNECT_PROJECT_ID');
		return null;
	}

	// Patch WebSocket before AppKit initializes
	patchWebSocketRelay();

	const { createAppKit } = await import('@reown/appkit');
	const { EthersAdapter } = await import('@reown/appkit-adapter-ethers');
	const { mainnet, bsc } = await import('@reown/appkit/networks');

	modal = createAppKit({
		adapters: [new EthersAdapter()],
		networks: [bsc, mainnet],
		projectId,
		metadata: {
			name: 'TokenKrafter',
			description: 'Deploy Custom ERC-20 Tokens Across Multiple Chains',
			url: typeof window !== 'undefined' ? window.location.origin : 'https://tokencrafter.com',
			icons: ['/favicon.svg']
		},
		features: {
			analytics: false
		},
		themeMode: 'dark'
	});

	return modal;
}

export function getAppKit() {
	return modal;
}
