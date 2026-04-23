import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import type { SupportedNetwork } from '$lib/structure';

let modal: any = null;

// Well-known chain configs for AppKit
const KNOWN_CHAINS: Record<number, { name: string; symbol: string; decimals: number }> = {
	1: { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
	56: { name: 'BNB Smart Chain', symbol: 'BNB', decimals: 18 },
	137: { name: 'Polygon', symbol: 'MATIC', decimals: 18 },
	42161: { name: 'Arbitrum One', symbol: 'ETH', decimals: 18 },
	10: { name: 'Optimism', symbol: 'ETH', decimals: 18 },
	8453: { name: 'Base', symbol: 'ETH', decimals: 18 },
	43114: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
	250: { name: 'Fantom', symbol: 'FTM', decimals: 18 },
	31337: { name: 'Localhost', symbol: 'ETH', decimals: 18 },
};

export async function initAppKit(networks?: SupportedNetwork[]) {
	if (modal || !browser) return modal;

	const projectId = env.PUBLIC_WALLET_CONNECT_PROJECT_ID;
	if (!projectId) {
		console.warn('Missing PUBLIC_WALLET_CONNECT_PROJECT_ID');
		return null;
	}

	const { createAppKit } = await import('@reown/appkit');
	const { EthersAdapter } = await import('@reown/appkit-adapter-ethers');
	const { mainnet, bsc, defineChain } = await import('@reown/appkit/networks');

	// Build chain list from DB networks
	const appKitNetworks: any[] = [];

	// Map well-known chains
	const builtInMap: Record<number, any> = {
		1: mainnet,
		56: bsc,
	};

	if (networks && networks.length > 0) {
		for (const net of networks) {
			// Use built-in AppKit network if available
			if (builtInMap[net.chain_id]) {
				appKitNetworks.push(builtInMap[net.chain_id]);
			} else {
				// Define custom chain
				const known = KNOWN_CHAINS[net.chain_id];
				appKitNetworks.push(defineChain({
					id: net.chain_id,
					caipNetworkId: `eip155:${net.chain_id}`,
					chainNamespace: 'eip155',
					name: known?.name || net.name,
					nativeCurrency: {
						name: known?.symbol || net.native_coin,
						symbol: known?.symbol || net.native_coin,
						decimals: known?.decimals || 18
					},
					rpcUrls: {
						default: { http: [net.rpc] }
					}
				}));
			}
		}
	}

	// Fallback: include common chains so wallet doesn't show "unsupported network"
	if (appKitNetworks.length === 0) {
		appKitNetworks.push(mainnet, bsc);
	}

	modal = createAppKit({
		adapters: [new EthersAdapter()],
		networks: appKitNetworks as any,
		projectId,
		metadata: {
			name: 'TokenKrafter',
			description: 'Deploy Custom ERC-20 Tokens Across Multiple Chains',
			url: typeof window !== 'undefined' ? window.location.origin : 'https://tokenkrafter.com',
			icons: ['/favicon.svg']
		},
		allWallets: 'SHOW',
		features: {
			analytics: false,
			allWallets: true
		},
		allowUnsupportedChain: true,
		themeMode: 'dark'
	});

	return modal;
}

export function getAppKit() {
	return modal;
}
