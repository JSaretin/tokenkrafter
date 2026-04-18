import { ethers } from 'ethers';

// ════════════════════════════════════════════════════════════════════════════
//  Constants
// ════════════════════════════════════════════════════════════════════════════

/** Token type bitfield — (partner ? 4 : 0) | (taxable ? 2 : 0) | (mintable ? 1 : 0). */
export enum TokenType {
	Basic = 0,
	Mintable = 1,
	Taxable = 2,
	TaxMintable = 3,
	Partner = 4,
	PartnerMint = 5,
	PartnerTax = 6,
	PartnerTaxMint = 7,
}

export const TOKEN_TYPE_LABELS: Record<TokenType, string> = {
	[TokenType.Basic]: 'Basic',
	[TokenType.Mintable]: 'Mintable',
	[TokenType.Taxable]: 'Taxable',
	[TokenType.TaxMintable]: 'Taxable + Mintable',
	[TokenType.Partner]: 'Partner',
	[TokenType.PartnerMint]: 'Partner + Mintable',
	[TokenType.PartnerTax]: 'Partner + Taxable',
	[TokenType.PartnerTaxMint]: 'Partner + Taxable + Mintable',
};

export const MAX_DEFAULT_PARTNER_BASES = 8;

export function computeTypeKey(flags: { isPartner: boolean; isTaxable: boolean; isMintable: boolean }): TokenType {
	return ((flags.isPartner ? 4 : 0) | (flags.isTaxable ? 2 : 0) | (flags.isMintable ? 1 : 0)) as TokenType;
}

export function tokenTypeLabel(type: number | bigint): string {
	return TOKEN_TYPE_LABELS[Number(type) as TokenType] ?? 'Unknown';
}

// ════════════════════════════════════════════════════════════════════════════
//  Raw types
// ════════════════════════════════════════════════════════════════════════════

export interface TokenInfoRaw {
	creator: string;
	isMintable: boolean;
	isTaxable: boolean;
	isPartnership: boolean;
}

export interface TokenViewRaw {
	tokenAddress: string;
	name: string;
	symbol: string;
	decimals: number;
	totalSupply: bigint;
	creator: string;
	isMintable: boolean;
	isTaxable: boolean;
	isPartnership: boolean;
}

export interface DayStatsRaw {
	basic: bigint;
	mintable: bigint;
	taxable: bigint;
	taxMintable: bigint;
	partner: bigint;
	partnerMint: bigint;
	partnerTax: bigint;
	partnerTaxMint: bigint;
	totalTokens: bigint;
	totalFeeUsdt: bigint;
}

export interface FactoryStateRaw {
	factoryOwner: string;
	totalTokens: bigint;
	totalFeeUsdt: bigint;
	feesPerType: bigint[];       // length 8
	countPerType: bigint[];      // length 8
	taxToStable: boolean;
	taxSlippage: bigint;
	refLevels: number;
	autoDistribute: boolean;
}

export interface ReferralStatsRaw {
	referred: bigint;
	earned: bigint;
	pending: bigint;
}

export interface CreationFeesRaw {
	creationFeeUsdt: bigint;
	launchFeeUsdt: bigint;
}

export interface TokensPageRaw { tokens: string[]; total: bigint; }
export interface TokensInfoPageRaw { views: TokenViewRaw[]; total: bigint; }

// ════════════════════════════════════════════════════════════════════════════
//  View types
// ════════════════════════════════════════════════════════════════════════════

export interface TokenInfoView extends TokenInfoRaw {
	typeKey: TokenType;
	typeLabel: string;
}

export interface TokenViewView {
	tokenAddress: string;
	name: string;
	symbol: string;
	decimals: number;
	totalSupply: string;
	creator: string;
	isMintable: boolean;
	isTaxable: boolean;
	isPartnership: boolean;
	typeKey: TokenType;
	typeLabel: string;
}

export interface DayStatsView {
	byType: Record<TokenType, number>;
	totalTokens: number;
	totalFeeUsdt: string;
}

export interface FactoryStateView {
	factoryOwner: string;
	totalTokens: number;
	totalFeeUsdt: string;
	feesPerType: string[];
	countPerType: number[];
	taxToStable: boolean;
	taxSlippagePct: number;
	refLevels: number;
	autoDistribute: boolean;
}

export interface ReferralStatsView {
	referred: number;
	earned: string;
	pending: string;
}

export interface CreationFeesView {
	creationFeeUsdt: string;
	launchFeeUsdt: string;
}

export interface TokensPageView { tokens: string[]; total: number; }
export interface TokensInfoPageView { views: TokenViewView[]; total: number; }

// ════════════════════════════════════════════════════════════════════════════
//  Write params
// ════════════════════════════════════════════════════════════════════════════

export interface CreateTokenParamsInput {
	name: string;
	symbol: string;
	totalSupply: string;
	decimals: number;
	isTaxable: boolean;
	isMintable: boolean;
	isPartner: boolean;
	bases: string[];
}
export interface CreateTokenParamsRaw {
	name: string;
	symbol: string;
	totalSupply: bigint;         // contract multiplies by 10^decimals itself
	decimals: number;
	isTaxable: boolean;
	isMintable: boolean;
	isPartner: boolean;
	bases: string[];
}

export interface CreateTokenCall { params: CreateTokenParamsInput; referral: string; }
export interface CreateTokenCallRaw { params: CreateTokenParamsRaw; referral: string; }

export interface OwnerCreateTokenCall {
	creator: string;
	params: CreateTokenParamsInput;
	referral: string;
}
export interface OwnerCreateTokenCallRaw {
	creator: string;
	params: CreateTokenParamsRaw;
	referral: string;
}

export interface RouterCreateTokenCall extends OwnerCreateTokenCall {}
export interface RouterCreateTokenCallRaw extends OwnerCreateTokenCallRaw {}

export interface SetImplementationParams { tokenType: TokenType; impl: string; }
export interface SetCreationFeeParams { tokenType: TokenType; fee: string; usdtDecimals: number; }
export interface SetTaxSlippageParams { slippagePct: number; }
export interface SetReferralLevelsParams { levels: number; }
export interface SetReferralPercentsParams { percents: number[]; }

export interface SetImplementationsAndFeesParams {
	impls: string[];
	fees: string[];
	usdtDecimals: number;
}
export interface SetImplementationsAndFeesParamsRaw {
	impls: string[];
	fees: bigint[];
}

export interface ForceRelaxTaxesParams {
	token: string;
	newBuyPct: number;
	newSellPct: number;
	newTransferPct: number;
}
export interface ForceRelaxTaxesParamsRaw {
	token: string;
	newBuyBps: bigint;
	newSellBps: bigint;
	newTransferBps: bigint;
}

export interface ForceRelaxLimitParams { token: string; amount: string; tokenDecimals: number; }
export interface ForceRelaxCooldownParams { token: string; cooldownSeconds: number; }

// ════════════════════════════════════════════════════════════════════════════
//  Events
// ════════════════════════════════════════════════════════════════════════════

export interface TokenCreatedEventRaw {
	creator: string;
	tokenAddress: string;
	tokenType: number;
	name: string;
	symbol: string;
	totalSupply: bigint;
	decimals: number;
	fee: bigint;
	referrer: string;
}
export interface TokenCreatedEventView {
	creator: string;
	tokenAddress: string;
	tokenType: TokenType;
	typeLabel: string;
	name: string;
	symbol: string;
	totalSupply: string;
	decimals: number;
	fee: string;
	referrer: string;
}

export interface ImplementationUpdatedEventRaw { tokenType: number; impl: string; }
export interface ImplementationUpdatedEventView { tokenType: TokenType; impl: string; }

export interface TaxProcessedEventRaw { token: string; amountIn: bigint; amountOut: bigint; }
export interface TaxProcessedEventView { token: string; amountIn: string; amountOut: string; }

export interface ConvertTaxToStableUpdatedEventRaw { enabled: boolean; }
export type ConvertTaxToStableUpdatedEventView = ConvertTaxToStableUpdatedEventRaw;

export interface TaxProcessFailedEventRaw { token: string; amount: bigint; }
export interface TaxProcessFailedEventView { token: string; amount: string; }

export interface ReferralRecordedEventRaw { creator: string; referrer: string; }
export type ReferralRecordedEventView = ReferralRecordedEventRaw;

export interface ReferralRewardDistributedEventRaw { referrer: string; amount: bigint; level: number; }
export interface ReferralRewardDistributedEventView { referrer: string; amount: string; level: number; }

export interface ReferralRewardClaimedEventRaw { user: string; amount: bigint; }
export interface ReferralRewardClaimedEventView { user: string; amount: string; }

export interface PlatformWalletUpdatedEventRaw { oldWallet: string; newWallet: string; }
export type PlatformWalletUpdatedEventView = PlatformWalletUpdatedEventRaw;

export interface AffiliateUpdatedEventRaw { previous: string; current: string; }
export type AffiliateUpdatedEventView = AffiliateUpdatedEventRaw;

export interface DefaultPartnerBaseAddedEventRaw { base: string; }
export type DefaultPartnerBaseAddedEventView = DefaultPartnerBaseAddedEventRaw;

export interface DefaultPartnerBaseRemovedEventRaw { base: string; }
export type DefaultPartnerBaseRemovedEventView = DefaultPartnerBaseRemovedEventRaw;

// ════════════════════════════════════════════════════════════════════════════
//  Converters — writes
// ════════════════════════════════════════════════════════════════════════════

export function toCreateTokenParamsRaw(p: CreateTokenParamsInput): CreateTokenParamsRaw {
	return {
		name: p.name,
		symbol: p.symbol,
		totalSupply: BigInt(p.totalSupply || '0'),
		decimals: p.decimals,
		isTaxable: p.isTaxable,
		isMintable: p.isMintable,
		isPartner: p.isPartner,
		bases: p.bases,
	};
}

export function toCreateTokenCallRaw(c: CreateTokenCall): CreateTokenCallRaw {
	return { params: toCreateTokenParamsRaw(c.params), referral: c.referral };
}

export function toOwnerCreateTokenCallRaw(c: OwnerCreateTokenCall): OwnerCreateTokenCallRaw {
	return { creator: c.creator, params: toCreateTokenParamsRaw(c.params), referral: c.referral };
}

export function toRouterCreateTokenCallRaw(c: RouterCreateTokenCall): RouterCreateTokenCallRaw {
	return toOwnerCreateTokenCallRaw(c);
}

export function toSetCreationFeeRaw(p: SetCreationFeeParams): bigint {
	return ethers.parseUnits(p.fee || '0', p.usdtDecimals);
}

export function toSetTaxSlippageRaw(p: SetTaxSlippageParams): bigint {
	return BigInt(Math.round(p.slippagePct * 100));
}

export function toSetReferralPercentsRaw(p: SetReferralPercentsParams): bigint[] {
	return p.percents.map(pct => BigInt(Math.round(pct * 100)));
}

export function toSetImplementationsAndFeesRaw(p: SetImplementationsAndFeesParams): SetImplementationsAndFeesParamsRaw {
	return {
		impls: p.impls,
		fees: p.fees.map(f => ethers.parseUnits(f || '0', p.usdtDecimals)),
	};
}

export function toForceRelaxTaxesRaw(p: ForceRelaxTaxesParams): ForceRelaxTaxesParamsRaw {
	const bps = (pct: number) => BigInt(Math.round(pct * 100));
	return {
		token: p.token,
		newBuyBps: bps(p.newBuyPct),
		newSellBps: bps(p.newSellPct),
		newTransferBps: bps(p.newTransferPct),
	};
}

export function toForceRelaxLimitRaw(p: ForceRelaxLimitParams): { token: string; amount: bigint } {
	return { token: p.token, amount: ethers.parseUnits(p.amount || '0', p.tokenDecimals) };
}

// ════════════════════════════════════════════════════════════════════════════
//  Converters — reads
// ════════════════════════════════════════════════════════════════════════════

export function toTokenInfoView(raw: TokenInfoRaw): TokenInfoView {
	const typeKey = computeTypeKey({
		isPartner: raw.isPartnership,
		isTaxable: raw.isTaxable,
		isMintable: raw.isMintable,
	});
	return { ...raw, typeKey, typeLabel: tokenTypeLabel(typeKey) };
}

export function toTokenViewView(raw: TokenViewRaw): TokenViewView {
	const typeKey = computeTypeKey({
		isPartner: raw.isPartnership,
		isTaxable: raw.isTaxable,
		isMintable: raw.isMintable,
	});
	return {
		tokenAddress: raw.tokenAddress,
		name: raw.name,
		symbol: raw.symbol,
		decimals: Number(raw.decimals),
		totalSupply: ethers.formatUnits(raw.totalSupply, Number(raw.decimals) || 18),
		creator: raw.creator,
		isMintable: raw.isMintable,
		isTaxable: raw.isTaxable,
		isPartnership: raw.isPartnership,
		typeKey,
		typeLabel: tokenTypeLabel(typeKey),
	};
}

export function toDayStatsView(raw: DayStatsRaw, usdtDecimals = 18): DayStatsView {
	return {
		byType: {
			[TokenType.Basic]: Number(raw.basic),
			[TokenType.Mintable]: Number(raw.mintable),
			[TokenType.Taxable]: Number(raw.taxable),
			[TokenType.TaxMintable]: Number(raw.taxMintable),
			[TokenType.Partner]: Number(raw.partner),
			[TokenType.PartnerMint]: Number(raw.partnerMint),
			[TokenType.PartnerTax]: Number(raw.partnerTax),
			[TokenType.PartnerTaxMint]: Number(raw.partnerTaxMint),
		},
		totalTokens: Number(raw.totalTokens),
		totalFeeUsdt: ethers.formatUnits(raw.totalFeeUsdt, usdtDecimals),
	};
}

export function toFactoryStateView(raw: FactoryStateRaw, usdtDecimals = 18): FactoryStateView {
	return {
		factoryOwner: raw.factoryOwner,
		totalTokens: Number(raw.totalTokens),
		totalFeeUsdt: ethers.formatUnits(raw.totalFeeUsdt, usdtDecimals),
		feesPerType: raw.feesPerType.map(f => ethers.formatUnits(f, usdtDecimals)),
		countPerType: raw.countPerType.map(c => Number(c)),
		taxToStable: raw.taxToStable,
		taxSlippagePct: Number(raw.taxSlippage) / 100,
		refLevels: Number(raw.refLevels),
		autoDistribute: raw.autoDistribute,
	};
}

export function toReferralStatsView(raw: ReferralStatsRaw, usdtDecimals = 18): ReferralStatsView {
	return {
		referred: Number(raw.referred),
		earned: ethers.formatUnits(raw.earned, usdtDecimals),
		pending: ethers.formatUnits(raw.pending, usdtDecimals),
	};
}

export function toCreationFeesView(raw: CreationFeesRaw, usdtDecimals = 18): CreationFeesView {
	return {
		creationFeeUsdt: ethers.formatUnits(raw.creationFeeUsdt, usdtDecimals),
		launchFeeUsdt: ethers.formatUnits(raw.launchFeeUsdt, usdtDecimals),
	};
}

export function toTokensPageView(raw: TokensPageRaw): TokensPageView {
	return { tokens: raw.tokens, total: Number(raw.total) };
}

export function toTokensInfoPageView(raw: TokensInfoPageRaw): TokensInfoPageView {
	return { views: raw.views.map(toTokenViewView), total: Number(raw.total) };
}

// ════════════════════════════════════════════════════════════════════════════
//  Converters — events
// ════════════════════════════════════════════════════════════════════════════

export function toTokenCreatedEventView(raw: TokenCreatedEventRaw, usdtDecimals = 18): TokenCreatedEventView {
	const typeKey = Number(raw.tokenType) as TokenType;
	return {
		creator: raw.creator,
		tokenAddress: raw.tokenAddress,
		tokenType: typeKey,
		typeLabel: tokenTypeLabel(typeKey),
		name: raw.name,
		symbol: raw.symbol,
		totalSupply: raw.totalSupply.toString(),
		decimals: Number(raw.decimals),
		fee: ethers.formatUnits(raw.fee, usdtDecimals),
		referrer: raw.referrer,
	};
}

export function toImplementationUpdatedEventView(raw: ImplementationUpdatedEventRaw): ImplementationUpdatedEventView {
	return { tokenType: Number(raw.tokenType) as TokenType, impl: raw.impl };
}

export function toTaxProcessedEventView(raw: TaxProcessedEventRaw, usdtDecimals = 18, tokenDecimals = 18): TaxProcessedEventView {
	return {
		token: raw.token,
		amountIn: ethers.formatUnits(raw.amountIn, tokenDecimals),
		amountOut: ethers.formatUnits(raw.amountOut, usdtDecimals),
	};
}

export function toTaxProcessFailedEventView(raw: TaxProcessFailedEventRaw, tokenDecimals = 18): TaxProcessFailedEventView {
	return { token: raw.token, amount: ethers.formatUnits(raw.amount, tokenDecimals) };
}

export function toReferralRewardDistributedEventView(
	raw: ReferralRewardDistributedEventRaw,
	usdtDecimals = 18
): ReferralRewardDistributedEventView {
	return { referrer: raw.referrer, amount: ethers.formatUnits(raw.amount, usdtDecimals), level: Number(raw.level) };
}

export function toReferralRewardClaimedEventView(
	raw: ReferralRewardClaimedEventRaw,
	usdtDecimals = 18
): ReferralRewardClaimedEventView {
	return { user: raw.user, amount: ethers.formatUnits(raw.amount, usdtDecimals) };
}

// ════════════════════════════════════════════════════════════════════════════
//  Event signatures + errors
// ════════════════════════════════════════════════════════════════════════════

export const TOKEN_FACTORY_EVENT_SIGNATURES = {
	TokenCreated: 'TokenCreated(address,address,uint8,string,string,uint256,uint8,uint256,address)',
	ImplementationUpdated: 'ImplementationUpdated(uint8,address)',
	TaxProcessed: 'TaxProcessed(address,uint256,uint256)',
	ConvertTaxToStableUpdated: 'ConvertTaxToStableUpdated(bool)',
	TaxProcessFailed: 'TaxProcessFailed(address,uint256)',
	ReferralRecorded: 'ReferralRecorded(address,address)',
	ReferralRewardDistributed: 'ReferralRewardDistributed(address,uint256,uint8)',
	ReferralRewardClaimed: 'ReferralRewardClaimed(address,uint256)',
	PlatformWalletUpdated: 'PlatformWalletUpdated(address,address)',
	AffiliateUpdated: 'AffiliateUpdated(address,address)',
	DefaultPartnerBaseAdded: 'DefaultPartnerBaseAdded(address)',
	DefaultPartnerBaseRemoved: 'DefaultPartnerBaseRemoved(address)',
} as const;

export const TOKEN_FACTORY_ERRORS = [
	'InvalidAddress', 'InvalidTokenType', 'ImplementationNotSet',
	'TransferFailed', 'CircularReferral', 'NoRewards', 'NoBalance',
	'InvalidParams', 'MaxLevelsExceeded', 'TotalExceedsMax',
	'NotFactoryToken', 'NotAuthorizedRouter',
] as const;
