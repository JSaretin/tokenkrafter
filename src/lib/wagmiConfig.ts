import { createAppKit } from '@reown/appkit';
import { EthersAdapter } from '@reown/appkit-adapter-ethers';
import { mainnet, bsc } from '@reown/appkit/networks';
import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';

let modal: ReturnType<typeof createAppKit> | null = null;

export function initAppKit() {
	if (modal || !browser) return modal;

	const projectId = env.PUBLIC_WALLET_CONNECT_PROJECT_ID;
	if (!projectId) {
		console.warn('Missing PUBLIC_WALLET_CONNECT_PROJECT_ID');
		return null;
	}

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
