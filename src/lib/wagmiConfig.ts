import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';

let modal: any = null;

export async function initAppKit() {
	if (modal || !browser) return modal;

	const projectId = env.PUBLIC_WALLET_CONNECT_PROJECT_ID;
	if (!projectId) {
		console.warn('Missing PUBLIC_WALLET_CONNECT_PROJECT_ID');
		return null;
	}

	const relayUrl = env.PUBLIC_WC_RELAY_PROXY;

	const { createAppKit } = await import('@reown/appkit');
	const { EthersAdapter } = await import('@reown/appkit-adapter-ethers');
	const { mainnet, bsc } = await import('@reown/appkit/networks');
	const { UniversalProvider } = await import('@walletconnect/universal-provider');

	const metadata = {
		name: 'TokenKrafter',
		description: 'Deploy Custom ERC-20 Tokens Across Multiple Chains',
		url: window.location.origin,
		icons: ['/favicon.svg']
	};

	const universalProvider = await UniversalProvider.init({
		projectId,
		metadata,
		...(relayUrl && { relayUrl })
	});

	modal = createAppKit({
		adapters: [new EthersAdapter()],
		networks: [bsc, mainnet],
		projectId,
		universalProvider,
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
