import { ethers } from 'ethers';

/**
 * TaxableTokenImpl — extends BasicTokenImpl with buy/sell/transfer taxes
 * and a per-field tax ceiling that locks on enableTrading / lockTaxCeiling.
 *
 * TaxableMintableTokenImpl additionally exposes `mint(to, amount)` + `burn(amount)`.
 */

// ════════════════════════════════════════════════════════════════════════════
//  Constants (hard caps)
// ════════════════════════════════════════════════════════════════════════════

export const MAX_BUY_TAX_BPS = 400;         // 4%
export const MAX_SELL_TAX_BPS = 400;         // 4%
export const MAX_TRANSFER_TAX_BPS = 200;    // 2%
export const MAX_TAX_WALLETS = 10;

// ════════════════════════════════════════════════════════════════════════════
//  Raw types
// ════════════════════════════════════════════════════════════════════════════

export interface TaxRatesRaw {
	buyTaxBps: bigint;
	sellTaxBps: bigint;
	transferTaxBps: bigint;
}

export interface TaxCeilingRaw {
	taxCeilingBuy: bigint;
	taxCeilingSell: bigint;
	taxCeilingTransfer: bigint;
	taxCeilingIsLocked: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
//  View types
// ════════════════════════════════════════════════════════════════════════════

export interface TaxRatesView {
	buyTaxPct: number;
	sellTaxPct: number;
	transferTaxPct: number;
}

export interface TaxCeilingView {
	buyCeilingPct: number;
	sellCeilingPct: number;
	transferCeilingPct: number;
	locked: boolean;
}

export interface TaxDistributionView {
	wallets: string[];
	sharesPct: number[];
}

// ════════════════════════════════════════════════════════════════════════════
//  Write params
// ════════════════════════════════════════════════════════════════════════════

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

export interface SetTaxDistributionParams {
	wallets: string[];
	sharesPct: number[];   // must sum to ≤ 100
}
export interface SetTaxDistributionParamsRaw {
	wallets: string[];
	sharesBps: number[];   // uint16, sum ≤ 10000
}

export interface ExcludeFromTaxParams { account: string; exempt: boolean; }

export interface ForceRelaxTaxesParams {
	newBuyPct: number;
	newSellPct: number;
	newTransferPct: number;
}
export interface ForceRelaxTaxesParamsRaw {
	newBuyBps: bigint;
	newSellBps: bigint;
	newTransferBps: bigint;
}

// ════════════════════════════════════════════════════════════════════════════
//  Events
// ════════════════════════════════════════════════════════════════════════════

export interface TaxDistributionUpdatedEventRaw { totalShareBps: bigint; }
export interface TaxDistributionUpdatedEventView { totalSharePct: number; }

export interface TaxExemptUpdatedEventRaw { account: string; exempt: boolean; }
export type TaxExemptUpdatedEventView = TaxExemptUpdatedEventRaw;

export interface TaxesUpdatedEventRaw {
	buyTaxBps: bigint;
	sellTaxBps: bigint;
	transferTaxBps: bigint;
}
export interface TaxesUpdatedEventView {
	buyTaxPct: number;
	sellTaxPct: number;
	transferTaxPct: number;
}

export interface TaxCeilingLockedEventRaw {
	buyCeiling: bigint;
	sellCeiling: bigint;
	transferCeiling: bigint;
}
export interface TaxCeilingLockedEventView {
	buyCeilingPct: number;
	sellCeilingPct: number;
	transferCeilingPct: number;
}

export interface TaxCeilingUnlockedEventRaw {}
export type TaxCeilingUnlockedEventView = TaxCeilingUnlockedEventRaw;

export interface TaxCeilingRelaxedEventRaw {
	buyCeiling: bigint;
	sellCeiling: bigint;
	transferCeiling: bigint;
}
export type TaxCeilingRelaxedEventView = TaxCeilingLockedEventView;

// ════════════════════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════════════════════

const bpsToPct = (bps: bigint | number) => Number(bps) / 100;
const pctToBps = (pct: number) => BigInt(Math.round(pct * 100));
const pctToBps16 = (pct: number) => Math.round(pct * 100);

// ════════════════════════════════════════════════════════════════════════════
//  Converters — writes
// ════════════════════════════════════════════════════════════════════════════

export function toSetTaxesRaw(p: SetTaxesParams): SetTaxesParamsRaw {
	return {
		buyTaxBps: pctToBps(p.buyTaxPct),
		sellTaxBps: pctToBps(p.sellTaxPct),
		transferTaxBps: pctToBps(p.transferTaxPct),
	};
}

export function toSetTaxDistributionRaw(p: SetTaxDistributionParams): SetTaxDistributionParamsRaw {
	return {
		wallets: p.wallets,
		sharesBps: p.sharesPct.map(pctToBps16),
	};
}

export function toForceRelaxTaxesRaw(p: ForceRelaxTaxesParams): ForceRelaxTaxesParamsRaw {
	return {
		newBuyBps: pctToBps(p.newBuyPct),
		newSellBps: pctToBps(p.newSellPct),
		newTransferBps: pctToBps(p.newTransferPct),
	};
}

// ════════════════════════════════════════════════════════════════════════════
//  Converters — reads
// ════════════════════════════════════════════════════════════════════════════

export function toTaxRatesView(raw: TaxRatesRaw): TaxRatesView {
	return {
		buyTaxPct: bpsToPct(raw.buyTaxBps),
		sellTaxPct: bpsToPct(raw.sellTaxBps),
		transferTaxPct: bpsToPct(raw.transferTaxBps),
	};
}

export function toTaxCeilingView(raw: TaxCeilingRaw): TaxCeilingView {
	return {
		buyCeilingPct: bpsToPct(raw.taxCeilingBuy),
		sellCeilingPct: bpsToPct(raw.taxCeilingSell),
		transferCeilingPct: bpsToPct(raw.taxCeilingTransfer),
		locked: raw.taxCeilingIsLocked,
	};
}

/** wallets[] and sharesBps[] come from separate getter calls — pass both. */
export function toTaxDistributionView(wallets: string[], sharesBps: number[]): TaxDistributionView {
	return { wallets, sharesPct: sharesBps.map(b => Number(b) / 100) };
}

// ════════════════════════════════════════════════════════════════════════════
//  Converters — events
// ════════════════════════════════════════════════════════════════════════════

export function toTaxDistributionUpdatedEventView(raw: TaxDistributionUpdatedEventRaw): TaxDistributionUpdatedEventView {
	return { totalSharePct: bpsToPct(raw.totalShareBps) };
}

export function toTaxesUpdatedEventView(raw: TaxesUpdatedEventRaw): TaxesUpdatedEventView {
	return {
		buyTaxPct: bpsToPct(raw.buyTaxBps),
		sellTaxPct: bpsToPct(raw.sellTaxBps),
		transferTaxPct: bpsToPct(raw.transferTaxBps),
	};
}

export function toTaxCeilingLockedEventView(raw: TaxCeilingLockedEventRaw): TaxCeilingLockedEventView {
	return {
		buyCeilingPct: bpsToPct(raw.buyCeiling),
		sellCeilingPct: bpsToPct(raw.sellCeiling),
		transferCeilingPct: bpsToPct(raw.transferCeiling),
	};
}

export const toTaxCeilingRelaxedEventView = toTaxCeilingLockedEventView;

// ════════════════════════════════════════════════════════════════════════════
//  Event signatures
// ════════════════════════════════════════════════════════════════════════════

export const TAXABLE_TOKEN_EVENT_SIGNATURES = {
	TaxDistributionUpdated: 'TaxDistributionUpdated(uint256)',
	TaxExemptUpdated: 'TaxExemptUpdated(address,bool)',
	TaxesUpdated: 'TaxesUpdated(uint256,uint256,uint256)',
	TaxCeilingLocked: 'TaxCeilingLocked(uint256,uint256,uint256)',
	TaxCeilingUnlocked: 'TaxCeilingUnlocked()',
	TaxCeilingRelaxed: 'TaxCeilingRelaxed(uint256,uint256,uint256)',
} as const;
