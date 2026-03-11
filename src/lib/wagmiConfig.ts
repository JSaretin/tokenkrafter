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
		if (urlStr.includes('relay.walletconnect.com') || urlStr.includes('relay.walletconnect.org')) {
			url = urlStr.replace(/relay\.walletconnect\.(com|org)/, relayProxy);
		}
		return new OriginalWebSocket(url, protocols);
	} as unknown as typeof WebSocket;
	PatchedWebSocket.prototype = OriginalWebSocket.prototype;
	PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
	PatchedWebSocket.OPEN = OriginalWebSocket.OPEN;
	PatchedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
	PatchedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
	window.WebSocket = PatchedWebSocket;

	// Patch fetch for all WalletConnect HTTP services
	const proxyMap: Record<string, string> = {
		'https://api.web3modal.org/': `https://${relayProxy}/w3m-api/`,
		'https://pulse.walletconnect.org/': `https://${relayProxy}/pulse/`,
		'https://verify.walletconnect.org/': `https://${relayProxy}/verify/`
	};

	const originalFetch = window.fetch;
	window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
		let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		for (const [origin, proxy] of Object.entries(proxyMap)) {
			if (url.includes(origin)) {
				const newUrl = url.replace(origin, proxy);
				if (typeof input === 'string') {
					input = newUrl;
				} else if (input instanceof URL) {
					input = new URL(newUrl);
				} else {
					input = new Request(newUrl, input);
				}
				break;
			}
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
