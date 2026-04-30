import { ethers } from 'ethers';

export const LAUNCHPAD_FACTORY_ABI = [
	// Launch creation — USDT-only. Caller must approve(usdt, factory, launchFee)
	// before calling. Not payable.
	'function createLaunch(address token_, uint256 totalTokens_, uint8 curveType_, uint256 softCap_, uint256 hardCap_, uint256 durationDays_, uint256 maxBuyBps_, uint256 creatorAllocationBps_, uint256 vestingDays_, uint256 startTimestamp_, uint256 lockDurationAfterListing_, uint256 minBuyUsdt_) external returns (address)',
	'function createLaunchCustomCurve(address token_, uint256 totalTokens_, uint8 curveType_, uint256 curveParam1_, uint256 curveParam2_, uint256 softCap_, uint256 hardCap_, uint256 durationDays_, uint256 maxBuyBps_, uint256 creatorAllocationBps_, uint256 vestingDays_, uint256 startTimestamp_, uint256 lockDurationAfterListing_, uint256 minBuyUsdt_) external returns (address)',
	'function cancelPendingLaunch(address token_) external',

	// View functions
	'function totalLaunches() view returns (uint256)',
	'function launches(uint256) view returns (address)',
	'function getLaunchByIndex(uint256 index) view returns (address)',
	'function getLaunches(uint256 offset, uint256 limit) view returns (address[] r, uint256 total)',
	'function getState() view returns (address factoryOwner, uint256 totalLaunchCount, uint256 totalFeeUsdt, uint256 fee)',
	'function getCreatorLaunches(address creator_) view returns (address[])',
	'function tokenToLaunch(address token_) view returns (address)',
	'function totalLaunchFeeEarnedUsdt() view returns (uint256)',

	// Admin
	'function owner() view returns (address)',
	'function platformWallet() view returns (address)',
	'function dexRouter() view returns (address)',
	'function usdt() view returns (address)',
	'function launchFee() view returns (uint256)',
	'function setLaunchFee(uint256 fee_) external',
	'function setPlatformWallet(address wallet_) external',
	'function setDexRouter(address router_) external',
	'function setAuthorizedRouter(address router_) external',
	'function proposeLaunchImplementation(address impl_) external',
	'function applyLaunchImplementation() external',
	'function cancelPendingLaunchImplementation() external',
	'function pendingLaunchImplementation() view returns (address)',
	'function pendingLaunchImplementationApplyAt() view returns (uint256)',
	'function LAUNCH_IMPL_TIMELOCK() view returns (uint256)',
	'function setCurveDefaults(tuple(uint256 linearSlope, uint256 linearIntercept, uint256 sqrtCoefficient, uint256 quadraticCoefficient, uint256 expBase, uint256 expKFactor) defaults_) external',
	'function withdrawFees(address token_) external',

	// Events
	'event LaunchCreated(address indexed launch, address indexed token, address indexed creator, uint8 curveType, uint256 softCap, uint256 hardCap, uint256 totalTokens)'
];

export const LAUNCH_INSTANCE_ABI = [
	// Unified buy. path is [tokenIn, ..., USDT]; path[0] = address(0)
	// signals native payment (msg.value must equal amountIn). For ERC20
	// payments msg.value must be 0. The frontend uses findBestRoute()
	// from tradeLens to compute the optimal multi-hop path off-chain.
	'function buy(address[] path, uint256 amountIn, uint256 minUsdtOut, uint256 minTokensOut) external payable',
	// Partial refund — pass the exact amount of launch tokens to return
	// for a pro-rata USDT share of your original payment.
	'function refund(uint256 tokensToReturn) external',
	'function depositTokens(uint256 amount) external',
	'function withdrawPendingTokens() external',
	'function graduate() external',
	'function resolveState() external',
	'function claimCreatorTokens() external',
	// Replaces the old creatorWithdrawAfterRefund — incremental, callable
	// any time during Refunding. Each call drains the contract's current
	// token balance to the creator.
	'function creatorWithdrawAvailable() external',
	// Platform wallet can sweep stranded USDT after STRANDED_SWEEP_DELAY
	// (5 years on the current deployment). The sweep window is a public
	// constant on the clone; reading it at runtime lets the UI pick up
	// future impl bumps without a frontend change.
	'function sweepStrandedUsdt() external',
	'function STRANDED_SWEEP_DELAY() view returns (uint256)',
	// Preflight + manual activation. preflight() returns (ready, reasonCode).
	// Reason codes: "" (ready), "NOT_PENDING", "NOT_FUNDED",
	// "NOT_EXCLUDED_FROM_LIMITS", "NOT_TAX_EXEMPT", "NOT_AUTHORIZED_LAUNCHER".
	'function preflight() view returns (bool ready, string reason)',
	'function activate() external',

	// View
	'function factory() view returns (address)',
	'function creator() view returns (address)',
	'function token() view returns (address)',
	'function usdt() view returns (address)',
	'function curveType() view returns (uint8)',
	'function softCap() view returns (uint256)',
	'function hardCap() view returns (uint256)',
	'function deadline() view returns (uint256)',
	'function maxBuyPerWallet() view returns (uint256)',
	'function tokensForCurve() view returns (uint256)',
	'function tokensForLP() view returns (uint256)',
	'function totalTokensRequired() view returns (uint256)',
	'function creatorAllocationBps() view returns (uint256)',
	'function vestingDuration() view returns (uint256)',
	'function vestingCliff() view returns (uint256)',
	'function lockDurationAfterListing() view returns (uint256)',
	'function minBuyUsdt() view returns (uint256)',
	'function state() view returns (uint8)',
	'function effectiveState() view returns (uint8)',
	'function tokensSold() view returns (uint256)',
	'function totalBaseRaised() view returns (uint256)',
	'function totalTokensDeposited() view returns (uint256)',
	'function basePaid(address) view returns (uint256)',
	'function tokensBought(address) view returns (uint256)',
	'function getCurrentPrice() view returns (uint256)',
	'function previewBuy(uint256 baseAmount) view returns (uint256 tokensOut, uint256 fee, uint256 priceImpactBps)',
	'function previewBuyFor(address buyer, uint256 baseAmount) view returns (uint256 tokensOut, uint256 fee, uint256 priceImpactBps)',
	'function vestingInfo() view returns (uint256 total, uint256 claimed, uint256 claimable, uint256 nextClaimTimestamp)',
	'function startTimestamp() view returns (uint256)',
	'function refundStartTimestamp() view returns (uint256)',
	'function totalBuyers() view returns (uint256)',
	'function totalPurchases() view returns (uint256)',
	'function getLaunchInfo() view returns (address token_, address creator_, uint8 curveType_, uint8 state_, uint256 softCap_, uint256 hardCap_, uint256 deadline_, uint256 totalBaseRaised_, uint256 tokensSold_, uint256 tokensForCurve_, uint256 tokensForLP_, uint256 creatorAllocationBps_, uint256 currentPrice_, address usdt_, uint256 startTimestamp_)',

	// Events
	'event TokenBought(address indexed buyer, uint256 tokenAmount, uint256 basePaid, uint256 newPrice)',
	'event Graduated(address indexed dexPair, uint256 baseToLP, uint256 tokensToLP, uint256 platformBaseFee, uint256 platformTokenFee)',
	'event Refunded(address indexed buyer, uint256 baseAmount)',
	'event CreatorReclaim(address indexed creator, uint256 tokenAmount)',
	'event LaunchActivated()',
	'event RefundingEnabled()'
];

export const CURVE_TYPES = ['Linear', 'Square Root', 'Quadratic', 'Exponential'] as const;
export type CurveType = 0 | 1 | 2 | 3;

export const LAUNCH_STATES = ['Pending', 'Active', 'Graduated', 'Refunding'] as const;
export type LaunchState = 0 | 1 | 2 | 3;

export interface LaunchInfo {
	address: string;
	token: string;
	creator: string;
	curveType: CurveType;
	state: LaunchState;
	softCap: bigint;     // in USDT
	hardCap: bigint;     // in USDT
	deadline: bigint;
	totalBaseRaised: bigint; // in USDT
	tokensSold: bigint;
	tokensForCurve: bigint;
	tokensForLP: bigint;
	creatorAllocationBps: bigint;
	currentPrice: bigint;  // in USDT per token
	usdtAddress: string;
	startTimestamp: bigint; // 0 = immediate, >0 = scheduled start
	totalTokensRequired: bigint;
	totalTokensDeposited: bigint;
	totalBuyers: number;
	totalPurchases: number;
	// Token metadata (fetched separately)
	tokenName?: string;
	tokenSymbol?: string;
	tokenDecimals?: number;
	usdtDecimals?: number;
}

export interface BuyPreview {
	tokensOut: bigint;
	fee: bigint;
	priceImpactBps: bigint;
}

export function stateColor(state: LaunchState): string {
	switch (state) {
		case 0: return 'amber';
		case 1: return 'cyan';
		case 2: return 'purple';
		case 3: return 'red';
	}
}

export function stateLabel(state: LaunchState): string {
	return LAUNCH_STATES[state];
}

export async function fetchLaunchInfo(
	launchAddress: string,
	provider: ethers.Provider
): Promise<LaunchInfo> {
	const instance = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, provider);
	const [info, totalTokensRequired, totalTokensDeposited, effectiveState, totalBuyers, totalPurchases] = await Promise.all([
		instance.getLaunchInfo(),
		instance.totalTokensRequired(),
		instance.totalTokensDeposited(),
		instance.effectiveState().catch(() => null),
		instance.totalBuyers().catch(() => 0n),
		instance.totalPurchases().catch(() => 0n),
	]);

	return {
		address: launchAddress,
		token: info.token_,
		creator: info.creator_,
		curveType: Number(info.curveType_) as CurveType,
		state: (effectiveState != null ? Number(effectiveState) : Number(info.state_)) as LaunchState,
		softCap: info.softCap_,
		hardCap: info.hardCap_,
		deadline: info.deadline_,
		totalBaseRaised: info.totalBaseRaised_,
		tokensSold: info.tokensSold_,
		tokensForCurve: info.tokensForCurve_,
		tokensForLP: info.tokensForLP_,
		creatorAllocationBps: info.creatorAllocationBps_,
		currentPrice: info.currentPrice_,
		usdtAddress: info.usdt_,
		startTimestamp: info.startTimestamp_,
		totalTokensRequired,
		totalTokensDeposited,
		totalBuyers: Number(totalBuyers),
		totalPurchases: Number(totalPurchases),
	};
}

export async function fetchTokenMeta(
	tokenAddress: string,
	provider: ethers.Provider
): Promise<{ name: string; symbol: string; decimals: number }> {
	const abi = [
		'function name() view returns (string)',
		'function symbol() view returns (string)',
		'function decimals() view returns (uint8)'
	];
	const token = new ethers.Contract(tokenAddress, abi, provider);
	const [name, symbol, decimals] = await Promise.all([
		token.name().catch(() => 'Unknown'),
		token.symbol().catch(() => '???'),
		token.decimals().catch(() => 18)
	]);
	return { name, symbol, decimals: Number(decimals) };
}

export function formatUsdt(amount: bigint, usdtDecimals: number = 18, displayDecimals: number = 2): string {
	const val = parseFloat(ethers.formatUnits(amount, usdtDecimals));
	if (val === 0) return '$0';
	// Caller's displayDecimals is the floor. For very small values we widen
	// automatically — users buying at $0.0099 deserve to see that rather than
	// a "< $0.01" placeholder that makes them think they bought at zero.
	let dec = displayDecimals;
	if (val < 1) dec = Math.max(dec, 4);
	if (val < 0.001) dec = Math.max(dec, 6);
	if (val < 0.000001) dec = Math.max(dec, 9);
	return '$' + val.toFixed(dec);
}

export function formatTokens(raw: bigint, tokenDecimals: number = 18, displayDecimals: number = 2): string {
	const val = parseFloat(ethers.formatUnits(raw, tokenDecimals));
	if (val === 0) return '0';
	if (val >= 1_000_000) return (val / 1_000_000).toFixed(1) + 'M';
	if (val >= 1_000) return (val / 1_000).toFixed(1) + 'K';
	return val.toFixed(displayDecimals);
}

export function progressPercent(raised: bigint, cap: bigint): number {
	if (cap === 0n) return 0;
	// Use 10000x precision to capture small percentages (e.g. 0.43%)
	const bps = Number((raised * 10000n) / cap);
	return Math.min(100, Math.round(bps) / 100);
}

export function timeRemaining(deadline: bigint): string {
	const now = BigInt(Math.floor(Date.now() / 1000));
	if (deadline <= now) return 'Expired';
	const diff = Number(deadline - now);
	const days = Math.floor(diff / 86400);
	const hours = Math.floor((diff % 86400) / 3600);
	if (days > 0) return `${days}d ${hours}h`;
	const mins = Math.floor((diff % 3600) / 60);
	return `${hours}h ${mins}m`;
}
