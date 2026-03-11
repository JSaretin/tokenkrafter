import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';

let modal: any = null;

/**
 * Rewrite a URL if it matches any blocked WalletConnect domain.
 * Returns the rewritten URL or null if no match.
 */
function rewriteWcUrl(url: string, relayProxy: string): string | null {
	const domainMap: Record<string, string> = {
		'api.web3modal.org': `${relayProxy}/w3m-api`,
		'api.web3modal.com': `${relayProxy}/w3m-api`,
		'pulse.walletconnect.org': `${relayProxy}/pulse`,
		'pulse.walletconnect.com': `${relayProxy}/pulse`,
		'verify.walletconnect.org': `${relayProxy}/verify`,
		'verify.walletconnect.com': `${relayProxy}/verify`
	};
	for (const [domain, proxyPath] of Object.entries(domainMap)) {
		if (url.includes(domain)) {
			return url.replace(`https://${domain}`, `https://${proxyPath}`).replace(`http://${domain}`, `https://${proxyPath}`);
		}
	}
	return null;
}

/**
 * Patch WebSocket, fetch, sendBeacon, and XMLHttpRequest to route
 * WalletConnect traffic through a custom proxy.
 * This allows users in regions where WalletConnect services are blocked
 * to connect without a VPN.
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
	const originalFetch = window.fetch;
	window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const rewritten = rewriteWcUrl(url, relayProxy);
		if (rewritten) {
			if (typeof input === 'string') {
				input = rewritten;
			} else if (input instanceof URL) {
				input = new URL(rewritten);
			} else {
				input = new Request(rewritten, input);
			}
		}
		return originalFetch.call(window, input, init);
	};

	// Patch sendBeacon (used by pulse analytics)
	if (navigator.sendBeacon) {
		const originalSendBeacon = navigator.sendBeacon.bind(navigator);
		navigator.sendBeacon = function (url: string, data?: BodyInit | null) {
			const rewritten = rewriteWcUrl(url, relayProxy);
			return originalSendBeacon(rewritten ?? url, data);
		};
	}

	// Patch XMLHttpRequest (fallback for some WC services)
	const OriginalXHR = window.XMLHttpRequest;
	const originalOpen = OriginalXHR.prototype.open;
	OriginalXHR.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
		const urlStr = typeof url === 'string' ? url : url.toString();
		const rewritten = rewriteWcUrl(urlStr, relayProxy);
		return originalOpen.call(this, method, rewritten ?? urlStr, ...rest);
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
