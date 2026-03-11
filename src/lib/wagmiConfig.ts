import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';

let modal: any = null;

/**
 * Patch WebSocket and fetch to route WalletConnect traffic through a custom proxy.
 * This allows users in regions where WalletConnect services are blocked
 * to connect without a VPN.
 *
 * Proxied services:
 * - relay.walletconnect.com (WebSocket) → relay proxy domain
 * - api.web3modal.org (HTTP API) → relay proxy domain /w3m-api/
 */
function patchWalletConnectProxy() {
	const relayProxy = env.PUBLIC_WC_RELAY_PROXY;
	if (!relayProxy) return;

	// Patch WebSocket for relay connections
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

	// Patch fetch for AppKit / Web3Modal API calls
	const originalFetch = window.fetch;
	window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
		if (typeof input === 'string' && input.includes('api.web3modal.org')) {
			input = input.replace('https://api.web3modal.org/', `https://${relayProxy}/w3m-api/`);
		} else if (input instanceof URL && input.href.includes('api.web3modal.org')) {
			input = new URL(input.href.replace('https://api.web3modal.org/', `https://${relayProxy}/w3m-api/`));
		} else if (input instanceof Request && input.url.includes('api.web3modal.org')) {
			const newUrl = input.url.replace('https://api.web3modal.org/', `https://${relayProxy}/w3m-api/`);
			input = new Request(newUrl, input);
		}
		return originalFetch.call(window, input, init);
	};
}

export async function initAppKit() {
	if (modal || !browser) return modal;

	const projectId = env.PUBLIC_WALLET_CONNECT_PROJECT_ID;
	if (!projectId) {
		console.warn('Missing PUBLIC_WALLET_CONNECT_PROJECT_ID');
		return null;
	}

	// Patch WebSocket + fetch before AppKit initializes
	patchWalletConnectProxy();

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
