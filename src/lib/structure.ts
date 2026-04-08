export interface SupportedNetwork {
	name: string;
	symbol: string;              // chain slug (e.g. "bsc", "eth", "base")
	chain_id: number;
	native_coin: string;
	usdt_address: string;
	usdc_address: string;
	platform_address: string;
	launchpad_address: string;
	router_address: string;
	dex_router: string;
	trade_router_address: string;
	rpc: string;
	explorer_url?: string;       // e.g. "https://bscscan.com"
	gecko_network?: string;      // e.g. "bsc" for GeckoTerminal API
}

export interface PaymentOption {
	symbol: string;
	name: string;
	address: string; // address(0) for native
	decimals: number;
}

export interface TokenInfo {
	name: string;
	symbol: string;
	totalSupply: string;
	decimals: number;
	isMintable?: boolean;
	isTaxable?: boolean;
	isPartner?: boolean;
}

export type SupportedNetworks = SupportedNetwork[];

const _CHAIN_SLUGS: Record<number, string> = { 56: 'bsc', 1: 'eth', 8453: 'base', 42161: 'arbitrum', 137: 'polygon' };
export function chainSlug(chainId: number): string { return _CHAIN_SLUGS[chainId] || 'bsc'; }
