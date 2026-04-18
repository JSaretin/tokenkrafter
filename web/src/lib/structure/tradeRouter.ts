import { ethers } from 'ethers';

// ════════════════════════════════════════════════════════════════════════════
//  Enums
// ════════════════════════════════════════════════════════════════════════════

export const WithdrawStatus = {
	Pending: 0,
	Confirmed: 1,
	Cancelled: 2,
} as const;
export type WithdrawStatus = typeof WithdrawStatus[keyof typeof WithdrawStatus];

const WITHDRAW_STATUS_LABELS: Record<WithdrawStatus, string> = {
	[WithdrawStatus.Pending]: 'Pending',
	[WithdrawStatus.Confirmed]: 'Confirmed',
	[WithdrawStatus.Cancelled]: 'Cancelled',
};

const WITHDRAW_STATUS_COLORS: Record<WithdrawStatus, string> = {
	[WithdrawStatus.Pending]: 'yellow',
	[WithdrawStatus.Confirmed]: 'green',
	[WithdrawStatus.Cancelled]: 'red',
};

export const withdrawStatusLabel = (status: number | bigint): string =>
	WITHDRAW_STATUS_LABELS[Number(status) as WithdrawStatus] ?? 'Unknown';

export const withdrawStatusColor = (status: number | bigint): string =>
	WITHDRAW_STATUS_COLORS[Number(status) as WithdrawStatus] ?? 'gray';

// ════════════════════════════════════════════════════════════════════════════
//  Raw on-chain types (bigint as ethers returns them)
// ════════════════════════════════════════════════════════════════════════════

export interface WithdrawRequestRaw {
	user: string;
	token: string;
	grossAmount: bigint;
	fee: bigint;
	netAmount: bigint;
	createdAt: bigint;
	expiresAt: bigint;
	status: number; // uint8
	bankRef: string; // bytes32 hex
	referrer: string;
}

export interface RouterStateRaw {
	owner: string;
	feeBps: bigint;
	payoutTimeout: bigint;
	platformWallet: string;
	totalEscrow: bigint;
	pendingCount: bigint;
	totalWithdrawals: bigint;
	paused: boolean;
	maxSlippageBps: bigint;
	affiliateEnabled: boolean;
	affiliateShareBps: bigint;
	admins: string[];
}

export interface PreviewDepositRaw {
	fee: bigint;
	netAmount: bigint;
}

export interface PendingWithdrawalsPageRaw {
	result: WithdrawRequestRaw[];
	total: bigint;
}

export interface UserWithdrawalsPageRaw {
	result: WithdrawRequestRaw[];
	withdrawIds: bigint[];
	total: bigint;
}

// ════════════════════════════════════════════════════════════════════════════
//  View types (human-readable for UI)
// ════════════════════════════════════════════════════════════════════════════

export interface WithdrawRequestView {
	user: string;
	token: string;
	grossAmount: string;       // formatted USDT
	fee: string;               // formatted USDT
	netAmount: string;         // formatted USDT
	createdAt: Date;
	expiresAt: Date;
	status: WithdrawStatus;
	statusLabel: string;
	statusColor: string;
	timedOut: boolean;         // status == Pending && now > expiresAt
	bankRef: string;           // bytes32 hex (keep raw — hashed, not displayable)
	referrer: string;
}

export interface RouterStateView {
	owner: string;
	feePct: number;            // bps → percent (100 bps = 1%)
	payoutTimeoutSec: number;
	platformWallet: string;
	totalEscrow: string;       // formatted USDT
	pendingCount: number;
	totalWithdrawals: number;
	paused: boolean;
	maxSlippagePct: number;
	affiliateEnabled: boolean;
	affiliateSharePct: number;
	admins: string[];
}

export interface PreviewDepositView {
	fee: string;               // formatted USDT
	netAmount: string;         // formatted USDT
}

export interface PendingWithdrawalsPageView {
	result: WithdrawRequestView[];
	total: number;
}

export interface UserWithdrawalsPageView {
	result: WithdrawRequestView[];
	withdrawIds: number[];
	total: number;
}

// ════════════════════════════════════════════════════════════════════════════
//  Write params — frontend-friendly (strings, numbers) & raw (bigint)
// ════════════════════════════════════════════════════════════════════════════

export interface SwapTokensParams {
	path: string[];
	amountIn: string;          // human-readable (of path[0])
	amountOutMin: string;      // human-readable (of path[last])
	hasTax: boolean;
	deadline?: number;         // unix seconds, optional
	tokenInDecimals: number;
	tokenOutDecimals: number;
}

export interface SwapTokensParamsRaw {
	path: string[];
	amountIn: bigint;
	amountOutMin: bigint;
	hasTax: boolean;
	deadline?: bigint;
}

export interface SwapETHForTokensParams {
	path: string[];
	amountIn: string;          // ETH (18 decimals)
	amountOutMin: string;      // human-readable
	hasTax: boolean;
	deadline?: number;
	tokenOutDecimals: number;
}

export interface SwapETHForTokensParamsRaw {
	path: string[];
	value: bigint;             // msg.value
	amountOutMin: bigint;
	hasTax: boolean;
	deadline?: bigint;
}

export interface SwapTokensForETHParams {
	path: string[];
	amountIn: string;
	amountOutMin: string;      // ETH
	hasTax: boolean;
	deadline?: number;
	tokenInDecimals: number;
}

export interface SwapTokensForETHParamsRaw {
	path: string[];
	amountIn: bigint;
	amountOutMin: bigint;      // 18-decimals (ETH)
	hasTax: boolean;
	deadline?: bigint;
}

export interface DepositParams {
	amount: string;            // USDT human
	bankRef: string;           // bytes32 hex (already hashed off-chain)
	referrer: string;
	usdtDecimals: number;
}

export interface DepositParamsRaw {
	amount: bigint;
	bankRef: string;
	referrer: string;
}

export interface DepositAndSwapParams {
	path: string[];
	amountIn: string;
	minUsdtOut: string;        // USDT human
	hasTax: boolean;
	bankRef: string;
	referrer: string;
	tokenInDecimals: number;
	usdtDecimals: number;
}

export interface DepositAndSwapParamsRaw {
	path: string[];
	amountIn: bigint;
	minUsdtOut: bigint;
	hasTax: boolean;
	bankRef: string;
	referrer: string;
}

export interface DepositETHParams {
	path: string[];
	value: string;             // ETH human (msg.value)
	minUsdtOut: string;        // USDT human
	bankRef: string;
	referrer: string;
	usdtDecimals: number;
}

export interface DepositETHParamsRaw {
	path: string[];
	value: bigint;
	minUsdtOut: bigint;
	bankRef: string;
	referrer: string;
}

/** Owner setter payloads (human-readable). */
export interface SetFeeParams { feePct: number; }
export interface SetPayoutTimeoutParams { payoutTimeoutSec: number; }
export interface SetMaxSlippageParams { maxSlippagePct: number; }
export interface SetMinWithdrawParams { minWithdrawUsdt: string; usdtDecimals: number; }
export interface SetAffiliateShareParams { affiliateSharePct: number; }

// ════════════════════════════════════════════════════════════════════════════
//  Events — raw log shapes + decoded views
// ════════════════════════════════════════════════════════════════════════════

export interface SwapEventRaw {
	user: string;
	tokenIn: string;
	tokenOut: string;
	amountIn: bigint;
	amountOut: bigint;
}

export interface SwapEventView {
	user: string;
	tokenIn: string;
	tokenOut: string;
	amountIn: string;          // formatted with tokenIn decimals
	amountOut: string;         // formatted with tokenOut decimals
}

export interface WithdrawRequestedEventRaw {
	id: bigint;
	user: string;
	token: string;
	grossAmount: bigint;
	fee: bigint;
	netAmount: bigint;
	bankRef: string;
	referrer: string;
	expiresAt: bigint;
}

export interface WithdrawRequestedEventView {
	id: number;
	user: string;
	token: string;
	grossAmount: string;
	fee: string;
	netAmount: string;
	bankRef: string;
	referrer: string;
	expiresAt: Date;
}

export interface WithdrawConfirmedEventRaw {
	id: bigint;
	admin: string;
	to: string;
	netAmount: bigint;
	grossAmount: bigint;
	fee: bigint;
	token: string;
}

export interface WithdrawConfirmedEventView {
	id: number;
	admin: string;
	to: string;
	netAmount: string;
	grossAmount: string;
	fee: string;
	token: string;
}

export interface WithdrawCancelledEventRaw {
	id: bigint;
	user: string;
	refundedAmount: bigint;
}

export interface WithdrawCancelledEventView {
	id: number;
	user: string;
	refundedAmount: string;
}

export interface FeesWithdrawnEventRaw { token: string; amount: bigint; to: string; }
export interface FeesWithdrawnEventView { token: string; amount: string; to: string; }

export interface TokenRescuedEventRaw { token: string; amount: bigint; to: string; }
export interface TokenRescuedEventView { token: string; amount: string; to: string; }

export interface FeeUpdatedEventRaw { oldFee: bigint; newFee: bigint; }
export interface FeeUpdatedEventView { oldFeePct: number; newFeePct: number; }

export interface TimeoutUpdatedEventRaw { oldTimeout: bigint; newTimeout: bigint; }
export interface TimeoutUpdatedEventView { oldTimeoutSec: number; newTimeoutSec: number; }

export interface AdminAddedEventRaw { admin: string; }
export interface AdminAddedEventView { admin: string; }

export interface AdminRemovedEventRaw { admin: string; }
export interface AdminRemovedEventView { admin: string; }

export interface PlatformWalletUpdatedEventRaw { oldWallet: string; newWallet: string; }
export interface PlatformWalletUpdatedEventView { oldWallet: string; newWallet: string; }

export interface MaxSlippageUpdatedEventRaw { oldBps: bigint; newBps: bigint; }
export interface MaxSlippageUpdatedEventView { oldPct: number; newPct: number; }

export interface MinWithdrawUpdatedEventRaw { oldMin: bigint; newMin: bigint; }
export interface MinWithdrawUpdatedEventView { oldMin: string; newMin: string; }

export interface AffiliatePaidEventRaw { id: bigint; referrer: string; amount: bigint; }
export interface AffiliatePaidEventView { id: number; referrer: string; amount: string; }

export interface AffiliateUpdatedEventRaw { previous: string; current: string; }
export interface AffiliateUpdatedEventView { previous: string; current: string; }

// ════════════════════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════════════════════

function bpsToPct(bps: bigint | number): number {
	return Number(bps) / 100;
}

function pctToBps(pct: number): bigint {
	return BigInt(Math.round(pct * 100));
}

function tsToDate(ts: bigint | number): Date {
	return new Date(Number(ts) * 1000);
}

// ════════════════════════════════════════════════════════════════════════════
//  Converters — writes (view → raw for contract call)
// ════════════════════════════════════════════════════════════════════════════

export function toSwapTokensParamsRaw(p: SwapTokensParams): SwapTokensParamsRaw {
	return {
		path: p.path,
		amountIn: ethers.parseUnits(p.amountIn || '0', p.tokenInDecimals),
		amountOutMin: ethers.parseUnits(p.amountOutMin || '0', p.tokenOutDecimals),
		hasTax: p.hasTax,
		deadline: p.deadline !== undefined ? BigInt(p.deadline) : undefined,
	};
}

export function toSwapETHForTokensParamsRaw(p: SwapETHForTokensParams): SwapETHForTokensParamsRaw {
	return {
		path: p.path,
		value: ethers.parseEther(p.amountIn || '0'),
		amountOutMin: ethers.parseUnits(p.amountOutMin || '0', p.tokenOutDecimals),
		hasTax: p.hasTax,
		deadline: p.deadline !== undefined ? BigInt(p.deadline) : undefined,
	};
}

export function toSwapTokensForETHParamsRaw(p: SwapTokensForETHParams): SwapTokensForETHParamsRaw {
	return {
		path: p.path,
		amountIn: ethers.parseUnits(p.amountIn || '0', p.tokenInDecimals),
		amountOutMin: ethers.parseEther(p.amountOutMin || '0'),
		hasTax: p.hasTax,
		deadline: p.deadline !== undefined ? BigInt(p.deadline) : undefined,
	};
}

export function toDepositParamsRaw(p: DepositParams): DepositParamsRaw {
	return {
		amount: ethers.parseUnits(p.amount || '0', p.usdtDecimals),
		bankRef: p.bankRef,
		referrer: p.referrer,
	};
}

export function toDepositAndSwapParamsRaw(p: DepositAndSwapParams): DepositAndSwapParamsRaw {
	return {
		path: p.path,
		amountIn: ethers.parseUnits(p.amountIn || '0', p.tokenInDecimals),
		minUsdtOut: ethers.parseUnits(p.minUsdtOut || '0', p.usdtDecimals),
		hasTax: p.hasTax,
		bankRef: p.bankRef,
		referrer: p.referrer,
	};
}

export function toDepositETHParamsRaw(p: DepositETHParams): DepositETHParamsRaw {
	return {
		path: p.path,
		value: ethers.parseEther(p.value || '0'),
		minUsdtOut: ethers.parseUnits(p.minUsdtOut || '0', p.usdtDecimals),
		bankRef: p.bankRef,
		referrer: p.referrer,
	};
}

export function toSetFeeBpsRaw(p: SetFeeParams): bigint { return pctToBps(p.feePct); }
export function toSetPayoutTimeoutRaw(p: SetPayoutTimeoutParams): bigint { return BigInt(p.payoutTimeoutSec); }
export function toSetMaxSlippageRaw(p: SetMaxSlippageParams): bigint { return pctToBps(p.maxSlippagePct); }
export function toSetMinWithdrawRaw(p: SetMinWithdrawParams): bigint {
	return ethers.parseUnits(p.minWithdrawUsdt || '0', p.usdtDecimals);
}
export function toSetAffiliateShareRaw(p: SetAffiliateShareParams): bigint { return pctToBps(p.affiliateSharePct); }

// ════════════════════════════════════════════════════════════════════════════
//  Converters — reads (raw → view for UI)
// ════════════════════════════════════════════════════════════════════════════

export interface WithdrawViewOpts {
	tokenDecimals?: number;    // defaults to 18 (USDT on BSC)
}

export function toWithdrawRequestView(
	raw: WithdrawRequestRaw,
	opts: WithdrawViewOpts = {}
): WithdrawRequestView {
	const dec = opts.tokenDecimals ?? 18;
	const status = Number(raw.status) as WithdrawStatus;
	const expiresAt = tsToDate(raw.expiresAt);
	const timedOut = status === WithdrawStatus.Pending && Date.now() > expiresAt.getTime();
	return {
		user: raw.user,
		token: raw.token,
		grossAmount: ethers.formatUnits(raw.grossAmount, dec),
		fee: ethers.formatUnits(raw.fee, dec),
		netAmount: ethers.formatUnits(raw.netAmount, dec),
		createdAt: tsToDate(raw.createdAt),
		expiresAt,
		status,
		statusLabel: withdrawStatusLabel(status),
		statusColor: withdrawStatusColor(status),
		timedOut,
		bankRef: raw.bankRef,
		referrer: raw.referrer,
	};
}

export function toRouterStateView(raw: RouterStateRaw): RouterStateView {
	return {
		owner: raw.owner,
		feePct: bpsToPct(raw.feeBps),
		payoutTimeoutSec: Number(raw.payoutTimeout),
		platformWallet: raw.platformWallet,
		totalEscrow: ethers.formatUnits(raw.totalEscrow, 18),
		pendingCount: Number(raw.pendingCount),
		totalWithdrawals: Number(raw.totalWithdrawals),
		paused: raw.paused,
		maxSlippagePct: bpsToPct(raw.maxSlippageBps),
		affiliateEnabled: raw.affiliateEnabled,
		affiliateSharePct: bpsToPct(raw.affiliateShareBps),
		admins: raw.admins,
	};
}

export function toPreviewDepositView(
	raw: PreviewDepositRaw,
	usdtDecimals = 18
): PreviewDepositView {
	return {
		fee: ethers.formatUnits(raw.fee, usdtDecimals),
		netAmount: ethers.formatUnits(raw.netAmount, usdtDecimals),
	};
}

export function toPendingWithdrawalsPageView(
	raw: PendingWithdrawalsPageRaw,
	opts: WithdrawViewOpts = {}
): PendingWithdrawalsPageView {
	return {
		result: raw.result.map(r => toWithdrawRequestView(r, opts)),
		total: Number(raw.total),
	};
}

export function toUserWithdrawalsPageView(
	raw: UserWithdrawalsPageRaw,
	opts: WithdrawViewOpts = {}
): UserWithdrawalsPageView {
	return {
		result: raw.result.map(r => toWithdrawRequestView(r, opts)),
		withdrawIds: raw.withdrawIds.map(i => Number(i)),
		total: Number(raw.total),
	};
}

// ════════════════════════════════════════════════════════════════════════════
//  Converters — events
// ════════════════════════════════════════════════════════════════════════════

export function toSwapEventView(
	raw: SwapEventRaw,
	tokenInDecimals = 18,
	tokenOutDecimals = 18
): SwapEventView {
	return {
		user: raw.user,
		tokenIn: raw.tokenIn,
		tokenOut: raw.tokenOut,
		amountIn: ethers.formatUnits(raw.amountIn, tokenInDecimals),
		amountOut: ethers.formatUnits(raw.amountOut, tokenOutDecimals),
	};
}

export function toWithdrawRequestedEventView(
	raw: WithdrawRequestedEventRaw,
	tokenDecimals = 18
): WithdrawRequestedEventView {
	return {
		id: Number(raw.id),
		user: raw.user,
		token: raw.token,
		grossAmount: ethers.formatUnits(raw.grossAmount, tokenDecimals),
		fee: ethers.formatUnits(raw.fee, tokenDecimals),
		netAmount: ethers.formatUnits(raw.netAmount, tokenDecimals),
		bankRef: raw.bankRef,
		referrer: raw.referrer,
		expiresAt: tsToDate(raw.expiresAt),
	};
}

export function toWithdrawConfirmedEventView(
	raw: WithdrawConfirmedEventRaw,
	tokenDecimals = 18
): WithdrawConfirmedEventView {
	return {
		id: Number(raw.id),
		admin: raw.admin,
		to: raw.to,
		netAmount: ethers.formatUnits(raw.netAmount, tokenDecimals),
		grossAmount: ethers.formatUnits(raw.grossAmount, tokenDecimals),
		fee: ethers.formatUnits(raw.fee, tokenDecimals),
		token: raw.token,
	};
}

export function toWithdrawCancelledEventView(
	raw: WithdrawCancelledEventRaw,
	tokenDecimals = 18
): WithdrawCancelledEventView {
	return {
		id: Number(raw.id),
		user: raw.user,
		refundedAmount: ethers.formatUnits(raw.refundedAmount, tokenDecimals),
	};
}

export function toFeesWithdrawnEventView(raw: FeesWithdrawnEventRaw, tokenDecimals = 18): FeesWithdrawnEventView {
	return { token: raw.token, amount: ethers.formatUnits(raw.amount, tokenDecimals), to: raw.to };
}

export function toTokenRescuedEventView(raw: TokenRescuedEventRaw, tokenDecimals = 18): TokenRescuedEventView {
	return { token: raw.token, amount: ethers.formatUnits(raw.amount, tokenDecimals), to: raw.to };
}

export function toFeeUpdatedEventView(raw: FeeUpdatedEventRaw): FeeUpdatedEventView {
	return { oldFeePct: bpsToPct(raw.oldFee), newFeePct: bpsToPct(raw.newFee) };
}

export function toTimeoutUpdatedEventView(raw: TimeoutUpdatedEventRaw): TimeoutUpdatedEventView {
	return { oldTimeoutSec: Number(raw.oldTimeout), newTimeoutSec: Number(raw.newTimeout) };
}

export function toAdminAddedEventView(raw: AdminAddedEventRaw): AdminAddedEventView { return { admin: raw.admin }; }
export function toAdminRemovedEventView(raw: AdminRemovedEventRaw): AdminRemovedEventView { return { admin: raw.admin }; }

export function toPlatformWalletUpdatedEventView(raw: PlatformWalletUpdatedEventRaw): PlatformWalletUpdatedEventView {
	return { oldWallet: raw.oldWallet, newWallet: raw.newWallet };
}

export function toMaxSlippageUpdatedEventView(raw: MaxSlippageUpdatedEventRaw): MaxSlippageUpdatedEventView {
	return { oldPct: bpsToPct(raw.oldBps), newPct: bpsToPct(raw.newBps) };
}

export function toMinWithdrawUpdatedEventView(
	raw: MinWithdrawUpdatedEventRaw,
	usdtDecimals = 18
): MinWithdrawUpdatedEventView {
	return {
		oldMin: ethers.formatUnits(raw.oldMin, usdtDecimals),
		newMin: ethers.formatUnits(raw.newMin, usdtDecimals),
	};
}

export function toAffiliatePaidEventView(raw: AffiliatePaidEventRaw, tokenDecimals = 18): AffiliatePaidEventView {
	return { id: Number(raw.id), referrer: raw.referrer, amount: ethers.formatUnits(raw.amount, tokenDecimals) };
}

export function toAffiliateUpdatedEventView(raw: AffiliateUpdatedEventRaw): AffiliateUpdatedEventView {
	return { previous: raw.previous, current: raw.current };
}

// ════════════════════════════════════════════════════════════════════════════
//  Event signatures — for filtering via contract.queryFilter / ws subscriptions
// ════════════════════════════════════════════════════════════════════════════

export const TRADE_ROUTER_EVENT_SIGNATURES = {
	Swap: 'Swap(address,address,address,uint256,uint256)',
	WithdrawRequested: 'WithdrawRequested(uint256,address,address,uint256,uint256,uint256,bytes32,address,uint256)',
	WithdrawConfirmed: 'WithdrawConfirmed(uint256,address,address,uint256,uint256,uint256,address)',
	WithdrawCancelled: 'WithdrawCancelled(uint256,address,uint256)',
	FeesWithdrawn: 'FeesWithdrawn(address,uint256,address)',
	TokenRescued: 'TokenRescued(address,uint256,address)',
	FeeUpdated: 'FeeUpdated(uint256,uint256)',
	TimeoutUpdated: 'TimeoutUpdated(uint256,uint256)',
	AdminAdded: 'AdminAdded(address)',
	AdminRemoved: 'AdminRemoved(address)',
	PlatformWalletUpdated: 'PlatformWalletUpdated(address,address)',
	MaxSlippageUpdated: 'MaxSlippageUpdated(uint256,uint256)',
	MinWithdrawUpdated: 'MinWithdrawUpdated(uint256,uint256)',
	AffiliatePaid: 'AffiliatePaid(uint256,address,uint256)',
	AffiliateUpdated: 'AffiliateUpdated(address,address)',
} as const;
