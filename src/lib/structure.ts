export interface SupportedNetwork {
	name: string;
	symbol: string;
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
