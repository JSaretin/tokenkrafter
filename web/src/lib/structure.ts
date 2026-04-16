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
	ws_rpc?: string;             // optional websocket endpoint — daemons subscribe via WS when set
	explorer_url?: string;       // e.g. "https://bscscan.com"
	gecko_network?: string;      // e.g. "bsc" for GeckoTerminal API
	/**
	 * Default base tokens shown in the create wizard for pool pre-registration.
	 * All entries are pre-selected; users may add more via a custom-address
	 * input. These drive `CreateTokenParams.bases` so the token's pool-lock
	 * gate can block grifter-created pools with malicious initial prices
	 * from opening before the creator's real listing.
	 */
	default_bases?: { address: string; symbol: string; name?: string }[];
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
