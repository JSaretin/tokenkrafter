import { ethers } from 'ethers';

// ════════════════════════════════════════════════════════════════════════════
//  Enums
// ════════════════════════════════════════════════════════════════════════════

export enum CurveType {
	Linear = 0,
	SquareRoot = 1,
	Quadratic = 2,
	Exponential = 3,
}

export enum LaunchState {
	Pending = 0,
	Active = 1,
	Graduated = 2,
	Refunding = 3,
}

export const CURVE_LABELS: Record<CurveType, string> = {
	[CurveType.Linear]: 'Linear',
	[CurveType.SquareRoot]: 'Square Root',
	[CurveType.Quadratic]: 'Quadratic',
	[CurveType.Exponential]: 'Exponential',
};

export const STATE_LABELS: Record<LaunchState, string> = {
	[LaunchState.Pending]: 'Pending',
	[LaunchState.Active]: 'Active',
	[LaunchState.Graduated]: 'Graduated',
	[LaunchState.Refunding]: 'Refunding',
};

export function curveLabel(curve: number | bigint): string {
	return CURVE_LABELS[Number(curve) as CurveType] ?? 'Unknown';
}

export function launchStateLabel(state: number | bigint): string {
	return STATE_LABELS[Number(state) as LaunchState] ?? 'Unknown';
}

// ════════════════════════════════════════════════════════════════════════════
//  Constants (mirror contract)
// ════════════════════════════════════════════════════════════════════════════

export const BUY_FEE_BPS = 100;
export const GRADUATION_FEE_BPS = 100;
export const BPS = 10000;
export const STRANDED_SWEEP_DELAY_DAYS = 1825;

// ════════════════════════════════════════════════════════════════════════════
//  Raw types
// ════════════════════════════════════════════════════════════════════════════

export interface PurchaseRaw {
	buyer: string;
	baseAmount: bigint;
	tokensReceived: bigint;
	fee: bigint;
	price: bigint;
	timestamp: bigint;
}

export interface LaunchInfoRaw {
	token: string;
	creator: string;
	curveType: bigint;
	state: bigint;
	softCap: bigint;
	hardCap: bigint;
	deadline: bigint;
	totalBaseRaised: bigint;
	tokensSold: bigint;
	tokensForCurve: bigint;
	tokensForLP: bigint;
	creatorAllocationBps: bigint;
	currentPrice: bigint;
	usdt: string;
	startTimestamp: bigint;
}

export interface BuyPreviewRaw {
	tokensOut: bigint;
	fee: bigint;
	priceImpactBps: bigint;
}

export interface ProgressBpsRaw { softCapBps: bigint; hardCapBps: bigint; }

export interface VestingInfoRaw {
	total: bigint;
	claimed: bigint;
	claimable: bigint;
	nextClaimTimestamp: bigint;
}

export interface PreflightRaw { ready: boolean; reason: string; }

export interface PurchasesPageRaw { purchases: PurchaseRaw[]; total: bigint; }
export interface BuyersPageRaw { buyers: string[]; total: bigint; }

// ════════════════════════════════════════════════════════════════════════════
//  View types
// ════════════════════════════════════════════════════════════════════════════

export interface PurchaseView {
	buyer: string;
	baseAmount: string;        // USDT
	tokensReceived: string;    // token
	fee: string;               // USDT
	price: string;             // USDT per 1e18 tokens
	timestamp: Date;
}

export interface LaunchInfoView {
	token: string;
	creator: string;
	curveType: CurveType;
	curveLabel: string;
	state: LaunchState;
	stateLabel: string;
	softCap: string;
	hardCap: string;
	deadline: Date;
	totalBaseRaised: string;
	tokensSold: string;
	tokensForCurve: string;
	tokensForLP: string;
	creatorAllocationPct: number;
	currentPrice: string;
	usdtAddress: string;
	startTimestamp: Date | null;
}

export interface BuyPreviewView {
	tokensOut: string;
	fee: string;
	priceImpactPct: number;
}

export interface ProgressBpsView {
	softCapPct: number;        // 0–100
	hardCapPct: number;        // 0–100
}

export interface VestingInfoView {
	total: string;
	claimed: string;
	claimable: string;
	nextClaimDate: Date | null;
}

export interface PreflightView {
	ready: boolean;
	reason: string;
}

export interface PurchasesPageView { purchases: PurchaseView[]; total: number; }
export interface BuyersPageView { buyers: string[]; total: number; }

// ════════════════════════════════════════════════════════════════════════════
//  Write params
// ════════════════════════════════════════════════════════════════════════════

export interface InitializeLaunchParams {
	creator: string;
	token: string;
	totalTokensForLaunch: string;   // token-decimals
	curveType: CurveType;
	curveParam1: string;            // 18-decimal virtual units
	curveParam2: string;            // 18-decimal virtual units
	softCap: string;                // USDT
	hardCap: string;                // USDT
	durationDays: number;
	maxBuyBps: number;              // 50 – 500
	creatorAllocationBps: number;   // 0 – 500
	vestingDays: number;            // 0, 30, 60, 90
	dexRouter: string;
	usdt: string;
	startTimestamp: number;         // unix seconds, 0 = immediate
	lockDurationAfterListing: number; // seconds, ≤ 24h
	minBuyUsdt: string;             // USDT human
	tokenDecimals: number;
	usdtDecimals: number;
}
export interface InitializeLaunchParamsRaw {
	creator: string;
	token: string;
	totalTokensForLaunch: bigint;
	curveType: number;
	curveParam1: bigint;
	curveParam2: bigint;
	softCap: bigint;
	hardCap: bigint;
	durationDays: bigint;
	maxBuyBps: bigint;
	creatorAllocationBps: bigint;
	vestingDays: bigint;
	dexRouter: string;
	usdt: string;
	startTimestamp: bigint;
	lockDurationAfterListing: bigint;
	minBuyUsdt: bigint;
}

export interface DepositTokensParams { amount: string; tokenDecimals: number; }
export interface NotifyDepositParams { amount: string; tokenDecimals: number; }

export interface BuyParams {
	path: string[];
	amountIn: string;               // path[0] human amount (native amount for address(0))
	minUsdtOut: string;             // USDT
	minTokensOut: string;           // launch token
	ref?: string;                   // optional referrer
	paymentTokenDecimals: number;   // decimals of path[0] (18 for native)
	usdtDecimals: number;
	tokenDecimals: number;          // launch token decimals
}
export interface BuyParamsRaw {
	path: string[];
	amountIn: bigint;
	minUsdtOut: bigint;
	minTokensOut: bigint;
	ref?: string;
	value: bigint;                  // msg.value (for native payments)
}

export interface RefundParams { tokensToReturn: string; tokenDecimals: number; }

// ════════════════════════════════════════════════════════════════════════════
//  Events — raw + view
// ════════════════════════════════════════════════════════════════════════════

export interface TokensDepositedEventRaw {
	creator: string;
	amount: bigint;
	totalDeposited: bigint;
	totalRequired: bigint;
}
export interface TokensDepositedEventView {
	creator: string;
	amount: string;
	totalDeposited: string;
	totalRequired: string;
}

export interface LaunchActivatedEventRaw {
	token: string;
	deadline: bigint;
	softCap: bigint;
	hardCap: bigint;
	tokensForCurve: bigint;
}
export interface LaunchActivatedEventView {
	token: string;
	deadline: Date;
	softCap: string;
	hardCap: string;
	tokensForCurve: string;
}

export interface TokenBoughtEventRaw {
	buyer: string;
	tokenAmount: bigint;
	basePaid: bigint;
	fee: bigint;
	newPrice: bigint;
	totalBaseRaised: bigint;
	totalTokensSold: bigint;
	remainingTokens: bigint;
	buyerCount: bigint;
}
export interface TokenBoughtEventView {
	buyer: string;
	tokenAmount: string;
	basePaid: string;
	fee: string;
	newPrice: string;
	totalBaseRaised: string;
	totalTokensSold: string;
	remainingTokens: string;
	buyerCount: number;
}

export interface GraduatedEventRaw {
	dexPair: string;
	baseToLP: bigint;
	tokensToLP: bigint;
	platformBaseFee: bigint;
	platformTokenFee: bigint;
	finalTotalRaised: bigint;
	finalTokensSold: bigint;
	totalBuyers: bigint;
}
export interface GraduatedEventView {
	dexPair: string;
	baseToLP: string;
	tokensToLP: string;
	platformBaseFee: string;
	platformTokenFee: string;
	finalTotalRaised: string;
	finalTokensSold: string;
	totalBuyers: number;
}

export interface RefundedEventRaw { buyer: string; baseAmount: bigint; tokensReturned: bigint; }
export interface RefundedEventView { buyer: string; baseAmount: string; tokensReturned: string; }

export interface CreatorClaimedEventRaw {
	creator: string;
	amount: bigint;
	totalClaimed: bigint;
	totalVested: bigint;
}
export interface CreatorClaimedEventView {
	creator: string;
	amount: string;
	totalClaimed: string;
	totalVested: string;
}

export interface RefundingEnabledEventRaw { token: string; totalRaised: bigint; softCap: bigint; }
export interface RefundingEnabledEventView { token: string; totalRaised: string; softCap: string; }

export interface CreatorWithdrawEventRaw { creator: string; tokenAmount: bigint; }
export interface CreatorWithdrawEventView { creator: string; tokenAmount: string; }

export interface CreatorReclaimEventRaw { creator: string; tokenAmount: bigint; }
export interface CreatorReclaimEventView { creator: string; tokenAmount: string; }

// ════════════════════════════════════════════════════════════════════════════
//  Converters — helpers
// ════════════════════════════════════════════════════════════════════════════

const tsToDate = (ts: bigint | number) => new Date(Number(ts) * 1000);
const tsToDateOrNull = (ts: bigint | number) => (Number(ts) === 0 ? null : tsToDate(ts));
const bpsToPct = (b: bigint | number) => Number(b) / 100;

// ════════════════════════════════════════════════════════════════════════════
//  Converters — writes
// ════════════════════════════════════════════════════════════════════════════

export function toInitializeLaunchParamsRaw(p: InitializeLaunchParams): InitializeLaunchParamsRaw {
	return {
		creator: p.creator,
		token: p.token,
		totalTokensForLaunch: ethers.parseUnits(p.totalTokensForLaunch || '0', p.tokenDecimals),
		curveType: Number(p.curveType),
		curveParam1: ethers.parseUnits(p.curveParam1 || '0', 18),
		curveParam2: ethers.parseUnits(p.curveParam2 || '0', 18),
		softCap: ethers.parseUnits(p.softCap || '0', p.usdtDecimals),
		hardCap: ethers.parseUnits(p.hardCap || '0', p.usdtDecimals),
		durationDays: BigInt(p.durationDays),
		maxBuyBps: BigInt(p.maxBuyBps),
		creatorAllocationBps: BigInt(p.creatorAllocationBps),
		vestingDays: BigInt(p.vestingDays),
		dexRouter: p.dexRouter,
		usdt: p.usdt,
		startTimestamp: BigInt(p.startTimestamp),
		lockDurationAfterListing: BigInt(p.lockDurationAfterListing),
		minBuyUsdt: ethers.parseUnits(p.minBuyUsdt || '0', p.usdtDecimals),
	};
}

export function toDepositTokensRaw(p: DepositTokensParams): bigint {
	return ethers.parseUnits(p.amount || '0', p.tokenDecimals);
}

export function toNotifyDepositRaw(p: NotifyDepositParams): bigint {
	return ethers.parseUnits(p.amount || '0', p.tokenDecimals);
}

export function toBuyParamsRaw(p: BuyParams): BuyParamsRaw {
	const isNative = p.path[0] === ethers.ZeroAddress;
	const amountIn = ethers.parseUnits(p.amountIn || '0', p.paymentTokenDecimals);
	return {
		path: p.path,
		amountIn,
		minUsdtOut: ethers.parseUnits(p.minUsdtOut || '0', p.usdtDecimals),
		minTokensOut: ethers.parseUnits(p.minTokensOut || '0', p.tokenDecimals),
		ref: p.ref,
		value: isNative ? amountIn : 0n,
	};
}

export function toRefundParamsRaw(p: RefundParams): bigint {
	return ethers.parseUnits(p.tokensToReturn || '0', p.tokenDecimals);
}

// ════════════════════════════════════════════════════════════════════════════
//  Converters — reads
// ════════════════════════════════════════════════════════════════════════════

export interface LaunchViewOpts {
	tokenDecimals?: number;
	usdtDecimals?: number;
}

export function toPurchaseView(raw: PurchaseRaw, opts: LaunchViewOpts = {}): PurchaseView {
	const td = opts.tokenDecimals ?? 18;
	const ud = opts.usdtDecimals ?? 18;
	return {
		buyer: raw.buyer,
		baseAmount: ethers.formatUnits(raw.baseAmount, ud),
		tokensReceived: ethers.formatUnits(raw.tokensReceived, td),
		fee: ethers.formatUnits(raw.fee, ud),
		price: ethers.formatUnits(raw.price, ud),
		timestamp: tsToDate(raw.timestamp),
	};
}

export function toLaunchInfoView(raw: LaunchInfoRaw, opts: LaunchViewOpts = {}): LaunchInfoView {
	const td = opts.tokenDecimals ?? 18;
	const ud = opts.usdtDecimals ?? 18;
	const curve = Number(raw.curveType) as CurveType;
	const state = Number(raw.state) as LaunchState;
	return {
		token: raw.token,
		creator: raw.creator,
		curveType: curve,
		curveLabel: curveLabel(curve),
		state,
		stateLabel: launchStateLabel(state),
		softCap: ethers.formatUnits(raw.softCap, ud),
		hardCap: ethers.formatUnits(raw.hardCap, ud),
		deadline: tsToDate(raw.deadline),
		totalBaseRaised: ethers.formatUnits(raw.totalBaseRaised, ud),
		tokensSold: ethers.formatUnits(raw.tokensSold, td),
		tokensForCurve: ethers.formatUnits(raw.tokensForCurve, td),
		tokensForLP: ethers.formatUnits(raw.tokensForLP, td),
		creatorAllocationPct: bpsToPct(raw.creatorAllocationBps),
		currentPrice: ethers.formatUnits(raw.currentPrice, ud),
		usdtAddress: raw.usdt,
		startTimestamp: tsToDateOrNull(raw.startTimestamp),
	};
}

export function toBuyPreviewView(raw: BuyPreviewRaw, opts: LaunchViewOpts = {}): BuyPreviewView {
	const td = opts.tokenDecimals ?? 18;
	const ud = opts.usdtDecimals ?? 18;
	return {
		tokensOut: ethers.formatUnits(raw.tokensOut, td),
		fee: ethers.formatUnits(raw.fee, ud),
		priceImpactPct: bpsToPct(raw.priceImpactBps),
	};
}

export function toProgressBpsView(raw: ProgressBpsRaw): ProgressBpsView {
	return { softCapPct: bpsToPct(raw.softCapBps), hardCapPct: bpsToPct(raw.hardCapBps) };
}

export function toVestingInfoView(raw: VestingInfoRaw, tokenDecimals = 18): VestingInfoView {
	return {
		total: ethers.formatUnits(raw.total, tokenDecimals),
		claimed: ethers.formatUnits(raw.claimed, tokenDecimals),
		claimable: ethers.formatUnits(raw.claimable, tokenDecimals),
		nextClaimDate: tsToDateOrNull(raw.nextClaimTimestamp),
	};
}

export function toPreflightView(raw: PreflightRaw): PreflightView {
	return { ready: raw.ready, reason: raw.reason };
}

export function toPurchasesPageView(raw: PurchasesPageRaw, opts: LaunchViewOpts = {}): PurchasesPageView {
	return {
		purchases: raw.purchases.map(p => toPurchaseView(p, opts)),
		total: Number(raw.total),
	};
}

export function toBuyersPageView(raw: BuyersPageRaw): BuyersPageView {
	return { buyers: raw.buyers, total: Number(raw.total) };
}

// ════════════════════════════════════════════════════════════════════════════
//  Converters — events
// ════════════════════════════════════════════════════════════════════════════

export function toTokensDepositedEventView(raw: TokensDepositedEventRaw, tokenDecimals = 18): TokensDepositedEventView {
	return {
		creator: raw.creator,
		amount: ethers.formatUnits(raw.amount, tokenDecimals),
		totalDeposited: ethers.formatUnits(raw.totalDeposited, tokenDecimals),
		totalRequired: ethers.formatUnits(raw.totalRequired, tokenDecimals),
	};
}

export function toLaunchActivatedEventView(raw: LaunchActivatedEventRaw, opts: LaunchViewOpts = {}): LaunchActivatedEventView {
	const td = opts.tokenDecimals ?? 18;
	const ud = opts.usdtDecimals ?? 18;
	return {
		token: raw.token,
		deadline: tsToDate(raw.deadline),
		softCap: ethers.formatUnits(raw.softCap, ud),
		hardCap: ethers.formatUnits(raw.hardCap, ud),
		tokensForCurve: ethers.formatUnits(raw.tokensForCurve, td),
	};
}

export function toTokenBoughtEventView(raw: TokenBoughtEventRaw, opts: LaunchViewOpts = {}): TokenBoughtEventView {
	const td = opts.tokenDecimals ?? 18;
	const ud = opts.usdtDecimals ?? 18;
	return {
		buyer: raw.buyer,
		tokenAmount: ethers.formatUnits(raw.tokenAmount, td),
		basePaid: ethers.formatUnits(raw.basePaid, ud),
		fee: ethers.formatUnits(raw.fee, ud),
		newPrice: ethers.formatUnits(raw.newPrice, ud),
		totalBaseRaised: ethers.formatUnits(raw.totalBaseRaised, ud),
		totalTokensSold: ethers.formatUnits(raw.totalTokensSold, td),
		remainingTokens: ethers.formatUnits(raw.remainingTokens, td),
		buyerCount: Number(raw.buyerCount),
	};
}

export function toGraduatedEventView(raw: GraduatedEventRaw, opts: LaunchViewOpts = {}): GraduatedEventView {
	const td = opts.tokenDecimals ?? 18;
	const ud = opts.usdtDecimals ?? 18;
	return {
		dexPair: raw.dexPair,
		baseToLP: ethers.formatUnits(raw.baseToLP, ud),
		tokensToLP: ethers.formatUnits(raw.tokensToLP, td),
		platformBaseFee: ethers.formatUnits(raw.platformBaseFee, ud),
		platformTokenFee: ethers.formatUnits(raw.platformTokenFee, td),
		finalTotalRaised: ethers.formatUnits(raw.finalTotalRaised, ud),
		finalTokensSold: ethers.formatUnits(raw.finalTokensSold, td),
		totalBuyers: Number(raw.totalBuyers),
	};
}

export function toRefundedEventView(raw: RefundedEventRaw, opts: LaunchViewOpts = {}): RefundedEventView {
	return {
		buyer: raw.buyer,
		baseAmount: ethers.formatUnits(raw.baseAmount, opts.usdtDecimals ?? 18),
		tokensReturned: ethers.formatUnits(raw.tokensReturned, opts.tokenDecimals ?? 18),
	};
}

export function toCreatorClaimedEventView(raw: CreatorClaimedEventRaw, tokenDecimals = 18): CreatorClaimedEventView {
	return {
		creator: raw.creator,
		amount: ethers.formatUnits(raw.amount, tokenDecimals),
		totalClaimed: ethers.formatUnits(raw.totalClaimed, tokenDecimals),
		totalVested: ethers.formatUnits(raw.totalVested, tokenDecimals),
	};
}

export function toRefundingEnabledEventView(raw: RefundingEnabledEventRaw, usdtDecimals = 18): RefundingEnabledEventView {
	return {
		token: raw.token,
		totalRaised: ethers.formatUnits(raw.totalRaised, usdtDecimals),
		softCap: ethers.formatUnits(raw.softCap, usdtDecimals),
	};
}

export function toCreatorWithdrawEventView(raw: CreatorWithdrawEventRaw, tokenDecimals = 18): CreatorWithdrawEventView {
	return { creator: raw.creator, tokenAmount: ethers.formatUnits(raw.tokenAmount, tokenDecimals) };
}

export function toCreatorReclaimEventView(raw: CreatorReclaimEventRaw, tokenDecimals = 18): CreatorReclaimEventView {
	return { creator: raw.creator, tokenAmount: ethers.formatUnits(raw.tokenAmount, tokenDecimals) };
}

// ════════════════════════════════════════════════════════════════════════════
//  Event signatures + errors
// ════════════════════════════════════════════════════════════════════════════

export const LAUNCH_INSTANCE_EVENT_SIGNATURES = {
	TokensDeposited: 'TokensDeposited(address,uint256,uint256,uint256)',
	LaunchActivated: 'LaunchActivated(address,uint256,uint256,uint256,uint256)',
	TokenBought: 'TokenBought(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)',
	Graduated: 'Graduated(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256)',
	Refunded: 'Refunded(address,uint256,uint256)',
	CreatorClaimed: 'CreatorClaimed(address,uint256,uint256,uint256)',
	RefundingEnabled: 'RefundingEnabled(address,uint256,uint256)',
	CreatorWithdraw: 'CreatorWithdraw(address,uint256)',
	CreatorReclaim: 'CreatorReclaim(address,uint256)',
} as const;

export const LAUNCH_INSTANCE_ERRORS = [
	'NotActive', 'NotCreator', 'InvalidToken', 'InvalidUsdt', 'InvalidCaps',
	'InvalidDuration', 'InvalidMaxBuy', 'InvalidCreatorAlloc', 'InvalidVesting',
	'CreatorAllocRequiresVesting', 'NotPending', 'ZeroAmount', 'InsufficientTokenBalance',
	'OnlyFactory', 'NothingDeposited', 'SendNativeCoin', 'LaunchExpired',
	'AmountTooSmall', 'ExceedsMaxBuy', 'SoftCapNotReached', 'OnlyCreatorCanGraduateEarly',
	'NotRefunding', 'NothingToRefund', 'ReturnTokensToRefund', 'OutstandingRefundsRemain',
	'NoTokens', 'NotGraduated', 'NoAllocation', 'CliffNotReached', 'NothingToClaim',
	'NoETH', 'TransferFailed', 'InsufficientTokensOut', 'LaunchNotStarted',
	'InvalidStartTimestamp', 'InvalidPath', 'PathMustEndAtUsdt', 'StrandedSweepTooEarly',
	'AlreadyInitialized', 'BelowMinBuy', 'InvalidMinBuy',
] as const;
