import { ethers } from 'ethers';

/**
 * Cross-cutting interfaces for token implementations. Mirrors
 * /solidty-contracts/contracts/shared/TokenInterfaces.sol.
 *
 * Per-variant surface (mint, tax, partner) lives in /tokens/*.ts.
 */

// ────────────────────────────────────────────────────────────────────────
//  IToken — unified initializer for every token variant
// ────────────────────────────────────────────────────────────────────────

export interface InitializeTokenParams {
	name: string;
	symbol: string;
	totalSupply: string;       // human-readable (parsed with decimals)
	decimals: number;
	creator: string;
	factory: string;
	dexFactory: string;
	bases: string[];
}

export interface InitializeTokenParamsRaw {
	name: string;
	symbol: string;
	totalSupply: bigint;
	decimals: number;
	creator: string;
	factory: string;
	dexFactory: string;
	bases: string[];
}

export function toInitializeTokenParamsRaw(p: InitializeTokenParams): InitializeTokenParamsRaw {
	return {
		name: p.name,
		symbol: p.symbol,
		totalSupply: ethers.parseUnits(p.totalSupply || '0', p.decimals),
		decimals: p.decimals,
		creator: p.creator,
		factory: p.factory,
		dexFactory: p.dexFactory,
		bases: p.bases,
	};
}

// ────────────────────────────────────────────────────────────────────────
//  IProtectedToken — protection management surface
// ────────────────────────────────────────────────────────────────────────

export interface EnableTradingParams { delaySeconds: number; }

export interface SetLimitParams {
	amount: string;            // tokens
	tokenDecimals: number;
}
export function toSetLimitRaw(p: SetLimitParams): bigint {
	return ethers.parseUnits(p.amount || '0', p.tokenDecimals);
}

export interface SetCooldownParams { cooldownSeconds: number; }
export interface SetExcludedFromLimitsParams { account: string; excluded: boolean; }
export interface SetAuthorizedLauncherParams { launcher: string; authorized: boolean; }
export interface AddPoolParams { base: string; }
export interface AddPoolByAddressParams { pool: string; }

// ────────────────────────────────────────────────────────────────────────
//  ITaxableToken — tax configuration
// ────────────────────────────────────────────────────────────────────────

export interface SetTaxesParams {
	buyTaxPct: number;
	sellTaxPct: number;
	transferTaxPct: number;
}
export interface SetTaxesParamsRaw {
	buyTaxBps: bigint;
	sellTaxBps: bigint;
	transferTaxBps: bigint;
}
export function toSetTaxesRaw(p: SetTaxesParams): SetTaxesParamsRaw {
	const bps = (pct: number) => BigInt(Math.round(pct * 100));
	return {
		buyTaxBps: bps(p.buyTaxPct),
		sellTaxBps: bps(p.sellTaxPct),
		transferTaxBps: bps(p.transferTaxPct),
	};
}

export interface SetTaxDistributionParams {
	wallets: string[];
	sharesPct: number[];       // must sum to 100 (10000 bps)
}
export interface SetTaxDistributionParamsRaw {
	wallets: string[];
	sharesBps: number[];       // uint16
}
export function toSetTaxDistributionRaw(p: SetTaxDistributionParams): SetTaxDistributionParamsRaw {
	return {
		wallets: p.wallets,
		sharesBps: p.sharesPct.map(pct => Math.round(pct * 100)),
	};
}

export interface ExcludeFromTaxParams { account: string; exempt: boolean; }

// ────────────────────────────────────────────────────────────────────────
//  ITokenFactoryTaxCallback
// ────────────────────────────────────────────────────────────────────────

export interface ProcessTaxParams { token: string; }

// ────────────────────────────────────────────────────────────────────────
//  IOwnableToken
// ────────────────────────────────────────────────────────────────────────

export interface TransferOwnershipParams { newOwner: string; }
