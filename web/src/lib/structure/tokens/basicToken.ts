import { ethers } from 'ethers';

/**
 * BasicTokenImpl — upgradeable ERC20 with pool-lock anti-snipe gate.
 * Also includes: classic protection knobs (maxWallet, maxTx, cooldown,
 * blacklist, exclusions), authorized-launcher role, holder/volume tracking.
 *
 * MintableTokenImpl extends this with `mint(to, amount)` + `burn(amount)`.
 */

// ════════════════════════════════════════════════════════════════════════════
//  Constants (mirror contract)
// ════════════════════════════════════════════════════════════════════════════

export const MAX_TRADING_DELAY_SECONDS = 24 * 60 * 60;
export const MAX_BLACKLIST_WINDOW_SECONDS = 72 * 60 * 60;
/** Solidity `type(uint256).max` — tradingStartTime sentinel for "not yet scheduled". */
export const TRADING_NOT_SCHEDULED = 2n ** 256n - 1n;

// ════════════════════════════════════════════════════════════════════════════
//  Raw types
// ════════════════════════════════════════════════════════════════════════════

export interface PoolInfoRaw { isPool: boolean; }

export interface GetPoolForBaseRaw { pair: string; registered: boolean; }

// ════════════════════════════════════════════════════════════════════════════
//  View types
// ════════════════════════════════════════════════════════════════════════════

/** Aggregated token view — frontend composes this from many getters. */
export interface BasicTokenStateView {
	maxWalletAmount: string;
	maxTransactionAmount: string;
	cooldownSeconds: number;
	blacklistWindowSeconds: number;
	tradingEnabledAt: Date | null;
	tradingStartTime: Date | null;     // null when scheduled-sentinel
	tradingScheduled: boolean;
	secondsUntilTradingOpens: number;  // 0 if already open, Infinity if not scheduled
	holderCount: number;
	totalVolume: string;
	dexFactory: string;
	tokenFactory: string;
}

export interface GetPoolForBaseView { pair: string; registered: boolean; }

// ════════════════════════════════════════════════════════════════════════════
//  Write params
// ════════════════════════════════════════════════════════════════════════════

export { type InitializeTokenParams, type InitializeTokenParamsRaw, toInitializeTokenParamsRaw } from '../shared/tokenInterfaces';

export interface EnableTradingParams { delaySeconds: number; }
export interface SetAuthorizedLauncherParams { launcher: string; authorized: boolean; }
export interface AddPoolParams { base: string; }
export interface AddPoolByAddressParams { pool: string; }

export interface SetLimitParams { amount: string; tokenDecimals: number; }
export interface SetCooldownTimeParams { cooldownSeconds: number; }
export interface SetBlacklistWindowParams { blacklistWindowSeconds: number; }
export interface SetBlacklistedParams { account: string; blocked: boolean; }
export interface SetExcludedFromLimitsParams { account: string; excluded: boolean; }
export interface WithdrawTokenParams { token: string; /** address(0) for native */ }

// Mintable extension
export interface MintParams { to: string; amount: string; tokenDecimals: number; }
export interface MintParamsRaw { to: string; amount: bigint; }
export interface BurnParams { amount: string; tokenDecimals: number; }

// ════════════════════════════════════════════════════════════════════════════
//  Events
// ════════════════════════════════════════════════════════════════════════════

export interface PoolRegisteredEventRaw { pool: string; base: string; }
export type PoolRegisteredEventView = PoolRegisteredEventRaw;

export interface TradingEnabledEventRaw { startsAt: bigint; }
export interface TradingEnabledEventView { startsAt: Date; }

export interface MaxWalletAmountUpdatedEventRaw { amount: bigint; }
export interface MaxWalletAmountUpdatedEventView { amount: string; }

export interface MaxTransactionAmountUpdatedEventRaw { amount: bigint; }
export interface MaxTransactionAmountUpdatedEventView { amount: string; }

export interface CooldownTimeUpdatedEventRaw { seconds_: bigint; }
export interface CooldownTimeUpdatedEventView { cooldownSeconds: number; }

export interface BlacklistWindowUpdatedEventRaw { seconds_: bigint; }
export interface BlacklistWindowUpdatedEventView { blacklistWindowSeconds: number; }

export interface BlacklistUpdatedEventRaw { account: string; blocked: boolean; }
export type BlacklistUpdatedEventView = BlacklistUpdatedEventRaw;

export interface ExcludedFromLimitsUpdatedEventRaw { account: string; excluded: boolean; }
export type ExcludedFromLimitsUpdatedEventView = ExcludedFromLimitsUpdatedEventRaw;

export interface AuthorizedLauncherUpdatedEventRaw { launcher: string; authorized: boolean; }
export type AuthorizedLauncherUpdatedEventView = AuthorizedLauncherUpdatedEventRaw;

// ════════════════════════════════════════════════════════════════════════════
//  Converters
// ════════════════════════════════════════════════════════════════════════════

const tsToDateOrNull = (ts: bigint) => (ts === 0n || ts === TRADING_NOT_SCHEDULED ? null : new Date(Number(ts) * 1000));

export function toSetLimitRaw(p: SetLimitParams): bigint {
	return p.amount === '' || p.amount === '0'
		? 0n
		: ethers.parseUnits(p.amount, p.tokenDecimals);
}

export function toMintParamsRaw(p: MintParams): MintParamsRaw {
	return { to: p.to, amount: ethers.parseUnits(p.amount || '0', p.tokenDecimals) };
}

export function toBurnParamsRaw(p: BurnParams): bigint {
	return ethers.parseUnits(p.amount || '0', p.tokenDecimals);
}

export function toTradingEnabledEventView(raw: TradingEnabledEventRaw): TradingEnabledEventView {
	return { startsAt: new Date(Number(raw.startsAt) * 1000) };
}

export function toLimitAmountEventView(
	raw: { amount: bigint },
	tokenDecimals = 18
): { amount: string } {
	return { amount: ethers.formatUnits(raw.amount, tokenDecimals) };
}

export function toBasicTokenStateView(
	raw: {
		maxWalletAmount: bigint;
		maxTransactionAmount: bigint;
		cooldownTime: bigint;
		blacklistWindow: bigint;
		tradingEnabledAt: bigint;
		tradingStartTime: bigint;
		holderCount: bigint;
		totalVolume: bigint;
		dexFactory: string;
		tokenFactory: string;
	},
	tokenDecimals = 18
): BasicTokenStateView {
	const scheduled = raw.tradingStartTime !== TRADING_NOT_SCHEDULED;
	const nowSec = Math.floor(Date.now() / 1000);
	let secondsUntilTradingOpens = 0;
	if (!scheduled) secondsUntilTradingOpens = Infinity;
	else {
		const startSec = Number(raw.tradingStartTime);
		secondsUntilTradingOpens = Math.max(0, startSec - nowSec);
	}
	return {
		maxWalletAmount: ethers.formatUnits(raw.maxWalletAmount, tokenDecimals),
		maxTransactionAmount: ethers.formatUnits(raw.maxTransactionAmount, tokenDecimals),
		cooldownSeconds: Number(raw.cooldownTime),
		blacklistWindowSeconds: Number(raw.blacklistWindow),
		tradingEnabledAt: raw.tradingEnabledAt === 0n ? null : new Date(Number(raw.tradingEnabledAt) * 1000),
		tradingStartTime: tsToDateOrNull(raw.tradingStartTime),
		tradingScheduled: scheduled,
		secondsUntilTradingOpens,
		holderCount: Number(raw.holderCount),
		totalVolume: ethers.formatUnits(raw.totalVolume, tokenDecimals),
		dexFactory: raw.dexFactory,
		tokenFactory: raw.tokenFactory,
	};
}

// ════════════════════════════════════════════════════════════════════════════
//  Event signatures
// ════════════════════════════════════════════════════════════════════════════

export const BASIC_TOKEN_EVENT_SIGNATURES = {
	PoolRegistered: 'PoolRegistered(address,address)',
	TradingEnabled: 'TradingEnabled(uint256)',
	MaxWalletAmountUpdated: 'MaxWalletAmountUpdated(uint256)',
	MaxTransactionAmountUpdated: 'MaxTransactionAmountUpdated(uint256)',
	CooldownTimeUpdated: 'CooldownTimeUpdated(uint256)',
	BlacklistWindowUpdated: 'BlacklistWindowUpdated(uint256)',
	BlacklistUpdated: 'BlacklistUpdated(address,bool)',
	ExcludedFromLimitsUpdated: 'ExcludedFromLimitsUpdated(address,bool)',
	AuthorizedLauncherUpdated: 'AuthorizedLauncherUpdated(address,bool)',
} as const;
