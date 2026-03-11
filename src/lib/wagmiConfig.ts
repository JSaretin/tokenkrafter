import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';

let modal: any = null;

function installWsProxy(proxyUrl: string) {
	const OrigWebSocket = window.WebSocket;
	const proxyHost = new URL(proxyUrl).host;
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
		installWsProxy(relayProxy);
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
