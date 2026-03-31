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

	const { createAppKit } = await import('@reown/appkit');
	const { EthersAdapter } = await import('@reown/appkit-adapter-ethers');
	const { mainnet, bsc, defineChain } = await import('@reown/appkit/networks');

	const localhost = defineChain({
		id: 31337,
		caipNetworkId: 'eip155:31337',
		chainNamespace: 'eip155',
		name: 'Localhost',
		nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
		rpcUrls: {
			default: { http: ['http://127.0.0.1:8545'] }
		}
	});

	modal = createAppKit({
		adapters: [new EthersAdapter()],
		networks: [localhost, mainnet],
		projectId,
		metadata: {
			name: 'TokenKrafter',
			description: 'Deploy Custom ERC-20 Tokens Across Multiple Chains',
			url: typeof window !== 'undefined' ? window.location.origin : 'https://tokencrafter.com',
			icons: ['/favicon.svg']
		},
		allWallets: 'SHOW',
		features: {
			analytics: false,
			allWallets: true
		},
		themeMode: 'dark'
	});

	return modal;
}

export function getAppKit() {
	return modal;
}
