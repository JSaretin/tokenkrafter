import { ethers } from 'ethers';

/**
 * MultiCallLens — constructor-only. One eth_call returns:
 *   - platform state (TokenFactory + LaunchpadFactory + TradeRouter)
 *   - native→USDT price
 *   - batch token info
 *   - user balance batch (native + per-token)
 *
 * Returns: (PlatformData, TokenData[], BalanceInfo[]) abi-encoded
 */

// ════════════════════════════════════════════════════════════════════════════
//  Raw types
// ════════════════════════════════════════════════════════════════════════════

export interface PlatformDataRaw {
	tfOwner: string;
	tfTotalTokens: bigint;
	tfTotalFeeUsdt: bigint;
	tfFeesPerType: bigint[];     // length 8
	tfCountPerType: bigint[];
	lpOwner: string;
	lpTotalLaunches: bigint;
	lpTotalFeeUsdt: bigint;
	lpLaunchFee: bigint;
	trOwner: string;
	trFeeBps: bigint;
	trPayoutTimeout: bigint;
	trPlatformWallet: string;
	trTotalEscrow: bigint;
	trPendingCount: bigint;
	trTotalWithdrawals: bigint;
	trPaused: boolean;
	trAffiliateEnabled: boolean;
	nativePriceUsdt: bigint;
}

export interface TokenDataRaw {
	addr: string;
	name: string;
	symbol: string;
	decimals: number;
	totalSupply: bigint;
	userBalance: bigint;
	creator: string;
	isMintable: boolean;
	isTaxable: boolean;
	isPartner: boolean;
}

export interface BalanceInfoRaw {
	token: string;               // address(0) = native
	balance: bigint;
	decimals: number;
}

export interface MultiCallResultRaw {
	platform: PlatformDataRaw;
	tokens: TokenDataRaw[];
	balances: BalanceInfoRaw[];
}

// ════════════════════════════════════════════════════════════════════════════
//  View types
// ════════════════════════════════════════════════════════════════════════════

export interface PlatformDataView {
	tfOwner: string;
	tfTotalTokens: number;
	tfTotalFeeUsdt: string;
	tfFeesPerType: string[];
	tfCountPerType: number[];
	lpOwner: string;
	lpTotalLaunches: number;
	lpTotalFeeUsdt: string;
	lpLaunchFee: string;
	trOwner: string;
	trFeePct: number;
	trPayoutTimeoutSec: number;
	trPlatformWallet: string;
	trTotalEscrow: string;
	trPendingCount: number;
	trTotalWithdrawals: number;
	trPaused: boolean;
	trAffiliateEnabled: boolean;
	nativePriceUsdt: string;     // formatted USDT per native
}

export interface TokenDataView {
	addr: string;
	name: string;
	symbol: string;
	decimals: number;
	totalSupply: string;
	userBalance: string;
	creator: string;
	isMintable: boolean;
	isTaxable: boolean;
	isPartner: boolean;
}

export interface BalanceInfoView {
	token: string;
	balance: string;
	decimals: number;
	isNative: boolean;
}

export interface MultiCallResultView {
	platform: PlatformDataView;
	tokens: TokenDataView[];
	balances: BalanceInfoView[];
}

// ════════════════════════════════════════════════════════════════════════════
//  Constructor params
// ════════════════════════════════════════════════════════════════════════════

export interface ConstructorParams {
	tokenFactory: string;
	launchpadFactory: string;
	tradeRouter: string;
	usdt: string;
	dexRouter: string;
	user: string;                // ZeroAddress to skip balances
	tokens: string[];
	balanceTokens: string[];
}
export type ConstructorParamsRaw = ConstructorParams;

// ════════════════════════════════════════════════════════════════════════════
//  Converters
// ════════════════════════════════════════════════════════════════════════════

const bpsToPct = (b: bigint | number) => Number(b) / 100;

export function toPlatformDataView(raw: PlatformDataRaw, usdtDecimals = 18): PlatformDataView {
	return {
		tfOwner: raw.tfOwner,
		tfTotalTokens: Number(raw.tfTotalTokens),
		tfTotalFeeUsdt: ethers.formatUnits(raw.tfTotalFeeUsdt, usdtDecimals),
		tfFeesPerType: raw.tfFeesPerType.map(f => ethers.formatUnits(f, usdtDecimals)),
		tfCountPerType: raw.tfCountPerType.map(c => Number(c)),
		lpOwner: raw.lpOwner,
		lpTotalLaunches: Number(raw.lpTotalLaunches),
		lpTotalFeeUsdt: ethers.formatUnits(raw.lpTotalFeeUsdt, usdtDecimals),
		lpLaunchFee: ethers.formatUnits(raw.lpLaunchFee, usdtDecimals),
		trOwner: raw.trOwner,
		trFeePct: bpsToPct(raw.trFeeBps),
		trPayoutTimeoutSec: Number(raw.trPayoutTimeout),
		trPlatformWallet: raw.trPlatformWallet,
		trTotalEscrow: ethers.formatUnits(raw.trTotalEscrow, usdtDecimals),
		trPendingCount: Number(raw.trPendingCount),
		trTotalWithdrawals: Number(raw.trTotalWithdrawals),
		trPaused: raw.trPaused,
		trAffiliateEnabled: raw.trAffiliateEnabled,
		nativePriceUsdt: ethers.formatUnits(raw.nativePriceUsdt, usdtDecimals),
	};
}

export function toTokenDataView(raw: TokenDataRaw): TokenDataView {
	const dec = Number(raw.decimals) || 18;
	return {
		addr: raw.addr,
		name: raw.name,
		symbol: raw.symbol,
		decimals: dec,
		totalSupply: ethers.formatUnits(raw.totalSupply, dec),
		userBalance: ethers.formatUnits(raw.userBalance, dec),
		creator: raw.creator,
		isMintable: raw.isMintable,
		isTaxable: raw.isTaxable,
		isPartner: raw.isPartner,
	};
}

export function toBalanceInfoView(raw: BalanceInfoRaw): BalanceInfoView {
	const dec = Number(raw.decimals) || 18;
	const isNative = raw.token === ethers.ZeroAddress;
	return {
		token: raw.token,
		balance: ethers.formatUnits(raw.balance, dec),
		decimals: dec,
		isNative,
	};
}

export function toMultiCallResultView(raw: MultiCallResultRaw, usdtDecimals = 18): MultiCallResultView {
	return {
		platform: toPlatformDataView(raw.platform, usdtDecimals),
		tokens: raw.tokens.map(toTokenDataView),
		balances: raw.balances.map(toBalanceInfoView),
	};
}
