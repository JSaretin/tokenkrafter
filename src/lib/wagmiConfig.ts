import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';

let modal: any = null;

// Route map: blocked WC domains → proxy paths on relay.tokenkrafter.com
const WC_PROXY_ROUTES: Record<string, string> = {
	'relay.walletconnect.org': '',       // WebSocket: proxied at root
	'relay.walletconnect.com': '',       // WebSocket: proxied at root
	'api.web3modal.org': '/w3m-api',     // HTTP: wallet list, explorer
	'api.web3modal.com': '/w3m-api',
	'pulse.walletconnect.org': '/pulse', // HTTP: analytics/telemetry
	'pulse.walletconnect.com': '/pulse',
	'verify.walletconnect.org': '/verify', // HTTP: domain attestation
	'verify.walletconnect.com': '/verify'
};

function installWcProxy(proxyUrl: string) {
	const proxyOrigin = new URL(proxyUrl).origin.replace('wss:', 'https:');
	const proxyHost = new URL(proxyUrl).host;

	// Proxy WebSocket connections (relay)
	const OrigWebSocket = window.WebSocket;
	// @ts-ignore
	window.WebSocket = function (url: string | URL, protocols?: string | string[]) {
		let targetUrl = typeof url === 'string' ? url : url.toString();
		if (targetUrl.includes('relay.walletconnect.org') || targetUrl.includes('relay.walletconnect.com')) {
			targetUrl = targetUrl
				.replace('relay.walletconnect.org', proxyHost)
				.replace('relay.walletconnect.com', proxyHost);
		}
		return protocols !== undefined
			? new OrigWebSocket(targetUrl, protocols)
			: new OrigWebSocket(targetUrl);
	} as any;
	window.WebSocket.prototype = OrigWebSocket.prototype;
	window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
	window.WebSocket.OPEN = OrigWebSocket.OPEN;
	window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
	window.WebSocket.CLOSED = OrigWebSocket.CLOSED;

	// Proxy HTTP fetch calls (api, pulse, verify)
	const origFetch = window.fetch;
	window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
		let url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		for (const [domain, path] of Object.entries(WC_PROXY_ROUTES)) {
			if (url.includes(domain) && !domain.startsWith('relay.')) {
				const parsed = new URL(url);
				const newUrl = `${proxyOrigin}${path}${parsed.pathname}${parsed.search}`;
				if (typeof input === 'string' || input instanceof URL) {
					return origFetch.call(window, newUrl, init);
				}
				return origFetch.call(window, new Request(newUrl, input), init);
			}
		}
		return origFetch.call(window, input, init);
	};
}

export async function initAppKit() {
	if (modal || !browser) return modal;

	const projectId = env.PUBLIC_WALLET_CONNECT_PROJECT_ID;
	if (!projectId) {
		console.warn('Missing PUBLIC_WALLET_CONNECT_PROJECT_ID');
		return null;
	}

	const relayProxy = env.PUBLIC_WC_RELAY_PROXY;
	if (relayProxy) {
		installWcProxy(relayProxy);
	}

	const { createAppKit } = await import('@reown/appkit');
	const { EthersAdapter } = await import('@reown/appkit-adapter-ethers');
	const { mainnet, bsc } = await import('@reown/appkit/networks');

	const metadata = {
		name: 'TokenKrafter',
		description: 'Deploy Custom ERC-20 Tokens Across Multiple Chains',
		url: window.location.origin,
		icons: ['/favicon.svg']
	};

	modal = createAppKit({
		adapters: [new EthersAdapter()],
		networks: [bsc, mainnet],
		projectId,
		metadata,
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
