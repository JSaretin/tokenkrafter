import { ethers } from 'ethers';

/**
 * SafuLens — constructor-only simulator (never deployed).
 * Returns per-token SAFU badge booleans + composite isSafu flag.
 *
 * Constructor args: (tokenFactory, dexFactory, weth, usdt, tokens[])
 * Returns: TokenSafu[] abi-encoded
 */

// ════════════════════════════════════════════════════════════════════════════
//  Raw / View
// ════════════════════════════════════════════════════════════════════════════

export interface TokenSafuRaw {
	token: string;
	isMintable: boolean;
	isTaxable: boolean;
	isPartner: boolean;
	owner: string;
	ownerIsZero: boolean;
	taxCeilingLocked: boolean;
	buyTaxBps: bigint;
	sellTaxBps: bigint;
	transferTaxBps: bigint;
	tradingEnabled: boolean;
	hasLiquidity: boolean;
	lpBurned: boolean;
	lpBurnedPct: bigint;         // 0-10000 bps
	isSafu: boolean;
}

export interface TokenSafuView {
	token: string;
	isMintable: boolean;
	isTaxable: boolean;
	isPartner: boolean;
	owner: string;
	ownerIsZero: boolean;
	taxCeilingLocked: boolean;
	buyTaxPct: number;
	sellTaxPct: number;
	transferTaxPct: number;
	tradingEnabled: boolean;
	hasLiquidity: boolean;
	lpBurned: boolean;
	lpBurnedPct: number;         // 0-100
	isSafu: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
//  Constructor params
// ════════════════════════════════════════════════════════════════════════════

export interface ConstructorParams {
	tokenFactory: string;
	dexFactory: string;
	weth: string;
	usdt: string;
	tokens: string[];
}
/** Raw == Input for this contract — all inputs are already addresses/arrays. */
export type ConstructorParamsRaw = ConstructorParams;

// ════════════════════════════════════════════════════════════════════════════
//  Converters
// ════════════════════════════════════════════════════════════════════════════

const bpsToPct = (b: bigint | number) => Number(b) / 100;

export function toTokenSafuView(raw: TokenSafuRaw): TokenSafuView {
	return {
		token: raw.token,
		isMintable: raw.isMintable,
		isTaxable: raw.isTaxable,
		isPartner: raw.isPartner,
		owner: raw.owner,
		ownerIsZero: raw.ownerIsZero,
		taxCeilingLocked: raw.taxCeilingLocked,
		buyTaxPct: bpsToPct(raw.buyTaxBps),
		sellTaxPct: bpsToPct(raw.sellTaxBps),
		transferTaxPct: bpsToPct(raw.transferTaxBps),
		tradingEnabled: raw.tradingEnabled,
		hasLiquidity: raw.hasLiquidity,
		lpBurned: raw.lpBurned,
		lpBurnedPct: bpsToPct(raw.lpBurnedPct),
		isSafu: raw.isSafu,
	};
}

export function toTokensSafuView(raws: TokenSafuRaw[]): TokenSafuView[] {
	return raws.map(toTokenSafuView);
}
