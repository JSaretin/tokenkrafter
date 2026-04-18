import { ethers } from 'ethers';
import {
	CurveType,
	LaunchState,
	toLaunchInfoView,
	toBuyPreviewView,
	toProgressBpsView,
	toVestingInfoView,
	toPreflightView,
	toPurchasesPageView,
	toBuyersPageView,
	toPurchaseView,
	toTokensDepositedEventView,
	toLaunchActivatedEventView,
	toTokenBoughtEventView,
	toGraduatedEventView,
	toRefundedEventView,
	toCreatorClaimedEventView,
	toRefundingEnabledEventView,
	toCreatorReclaimEventView,
} from './structure/launchInstance';
import type {
	LaunchInfoRaw,
	LaunchInfoView,
	BuyPreviewRaw,
	BuyPreviewView,
	ProgressBpsRaw,
	ProgressBpsView,
	VestingInfoRaw,
	VestingInfoView,
	PreflightRaw,
	PreflightView,
	PurchaseRaw,
	PurchaseView,
	PurchasesPageView,
	BuyersPageView,
	LaunchViewOpts,
	TokensDepositedEventRaw,
	TokensDepositedEventView,
	LaunchActivatedEventRaw,
	LaunchActivatedEventView,
	TokenBoughtEventRaw,
	TokenBoughtEventView,
	GraduatedEventRaw,
	GraduatedEventView,
	RefundedEventRaw,
	RefundedEventView,
	CreatorClaimedEventRaw,
	CreatorClaimedEventView,
	RefundingEnabledEventRaw,
	RefundingEnabledEventView,
	CreatorReclaimEventRaw,
	CreatorReclaimEventView,
	PausedChangedEventRaw,
	PausedChangedEventView,
} from './structure/launchInstance';

// ════════════════════════════════════════════════════════════════════════════
//  ABI — comprehensive surface for LaunchInstance clones.
//
//  Kept local to this client (rather than importing the trimmed
//  `LAUNCH_INSTANCE_ABI` from ./launchpad) because that one is missing the
//  referrer-aware buy overload, the new paused()/setPaused()/stateHash()
//  surface, and richer event signatures the indexer needs.
// ════════════════════════════════════════════════════════════════════════════

const LAUNCH_INSTANCE_CLIENT_ABI = [
	// ── Writes (buy variants use overloads — include both) ────
	'function buy(address[] path, uint256 amountIn, uint256 minUsdtOut, uint256 minTokensOut) external payable',
	'function buy(address[] path, uint256 amountIn, uint256 minUsdtOut, uint256 minTokensOut, address ref) external payable',
	'function depositTokens(uint256 amount) external',
	'function activate() external',
	'function withdrawPendingTokens() external',
	'function refund(uint256 tokensToReturn) external',
	'function graduate() external',
	'function creatorWithdrawAvailable() external',
	'function claimCreatorTokens() external',
	'function sweepStrandedUsdt() external',
	'function resolveState() external',
	'function recoverETH() external',
	'function setPaused(bool paused_) external',

	// ── Reads ──────────────────────────────────────────────────
	'function factory() view returns (address)',
	'function creator() view returns (address)',
	'function token() view returns (address)',
	'function usdt() view returns (address)',
	'function paused() view returns (bool)',
	'function state() view returns (uint8)',
	'function effectiveState() view returns (uint8)',
	'function curveType() view returns (uint8)',
	'function curveParam1() view returns (uint256)',
	'function curveParam2() view returns (uint256)',
	'function softCap() view returns (uint256)',
	'function hardCap() view returns (uint256)',
	'function deadline() view returns (uint256)',
	'function maxBuyPerWallet() view returns (uint256)',
	'function minBuyUsdt() view returns (uint256)',
	'function tokensSold() view returns (uint256)',
	'function tokensForCurve() view returns (uint256)',
	'function tokensForLP() view returns (uint256)',
	'function totalBaseRaised() view returns (uint256)',
	'function totalBuyFeesCollected() view returns (uint256)',
	'function totalTokensRequired() view returns (uint256)',
	'function totalTokensDeposited() view returns (uint256)',
	'function totalBuyers() view returns (uint256)',
	'function totalPurchases() view returns (uint256)',
	'function basePaid(address) view returns (uint256)',
	'function grossPaid(address) view returns (uint256)',
	'function tokensBought(address) view returns (uint256)',
	'function getCurrentPrice() view returns (uint256)',
	'function getCostForTokens(uint256 amount) view returns (uint256)',
	'function getTokensForBase(uint256 baseAmount) view returns (uint256)',
	'function previewBuy(uint256 baseAmount) view returns (uint256 tokensOut, uint256 fee, uint256 priceImpactBps)',
	'function previewBuyFor(address buyer, uint256 baseAmount) view returns (uint256 tokensOut, uint256 fee, uint256 priceImpactBps)',
	'function progressBps() view returns (uint256 softCapBps, uint256 hardCapBps)',
	'function vestingInfo() view returns (uint256 total, uint256 claimed, uint256 claimable, uint256 nextClaimTimestamp)',
	'function startTimestamp() view returns (uint256)',
	'function graduationTimestamp() view returns (uint256)',
	'function refundStartTimestamp() view returns (uint256)',
	'function stateHash() view returns (bytes32)',
	'function getLaunchInfo() view returns (address token_, address creator_, uint8 curveType_, uint8 state_, uint256 softCap_, uint256 hardCap_, uint256 deadline_, uint256 totalBaseRaised_, uint256 tokensSold_, uint256 tokensForCurve_, uint256 tokensForLP_, uint256 creatorAllocationBps_, uint256 currentPrice_, address usdt_, uint256 startTimestamp_)',
	'function preflight() view returns (bool ready, string reason)',
	'function getPurchases(uint256 offset, uint256 limit) view returns (tuple(address buyer, uint256 baseAmount, uint256 tokensReceived, uint256 fee, uint256 price, uint256 timestamp)[] purchases, uint256 total)',
	'function getBuyers(uint256 offset, uint256 limit) view returns (address[] buyers, uint256 total)',
	'function getPurchase(uint256 index) view returns (tuple(address buyer, uint256 baseAmount, uint256 tokensReceived, uint256 fee, uint256 price, uint256 timestamp))',

	// ── Events ─────────────────────────────────────────────────
	'event TokensDeposited(address indexed creator, uint256 amount, uint256 totalDeposited, uint256 totalRequired)',
	'event LaunchActivated(address indexed token, uint256 deadline, uint256 softCap, uint256 hardCap, uint256 tokensForCurve)',
	'event TokenBought(address indexed buyer, uint256 tokenAmount, uint256 basePaid, uint256 fee, uint256 newPrice, uint256 totalBaseRaised, uint256 totalTokensSold, uint256 remainingTokens, uint256 buyerCount)',
	'event Graduated(address indexed dexPair, uint256 baseToLP, uint256 tokensToLP, uint256 platformBaseFee, uint256 platformTokenFee, uint256 finalTotalRaised, uint256 finalTokensSold, uint256 totalBuyers)',
	'event Refunded(address indexed buyer, uint256 baseAmount, uint256 tokensReturned)',
	'event CreatorClaimed(address indexed creator, uint256 amount, uint256 totalClaimed, uint256 totalVested)',
	'event RefundingEnabled(address indexed token, uint256 totalRaised, uint256 softCap)',
	'event CreatorWithdraw(address indexed creator, uint256 tokenAmount)',
	'event CreatorReclaim(address indexed creator, uint256 tokenAmount)',
	'event PausedChanged(bool paused)',
] as const;

// ════════════════════════════════════════════════════════════════════════════
//  Client-local types
// ════════════════════════════════════════════════════════════════════════════

/** Combined per-user position (all three accounting mappings). */
export interface UserPosition {
	basePaid: bigint;      // net USDT (after fee) — used for refunds + max buy
	grossPaid: bigint;     // gross USDT (including fee) — what the user actually spent
	tokensBought: bigint;  // launch tokens purchased
}

export interface ProgressBpsNumeric {
	softCapBps: number;
	hardCapBps: number;
}

/** vestingInfo() unwrapped — timestamp is a number since it fits within 2^53. */
export interface VestingInfoNumeric {
	total: bigint;
	claimed: bigint;
	claimable: bigint;
	nextClaimTimestamp: number;
}

/** Raw buy preview tuple. */
export type BuyPreview = BuyPreviewRaw;

/** Base write result shape — every write returns the tx + its mined receipt. */
export interface WriteResult {
	tx: ethers.TransactionResponse;
	receipt: ethers.TransactionReceipt | null;
}

export interface BuyResult extends WriteResult {
	/** Parsed TokenBought event (null if not found in the receipt logs). */
	tokenBought: TokenBoughtEventRaw | null;
	/** Parsed Graduated event — present when the buy triggered auto-graduation. */
	graduated: GraduatedEventRaw | null;
}

export interface DepositTokensResult extends WriteResult {
	tokensDeposited: TokensDepositedEventRaw | null;
	launchActivated: LaunchActivatedEventRaw | null;
}

export interface ActivateResult extends WriteResult {
	launchActivated: LaunchActivatedEventRaw | null;
}

export interface RefundResult extends WriteResult {
	refunded: RefundedEventRaw | null;
}

export interface GraduateResult extends WriteResult {
	graduated: GraduatedEventRaw | null;
}

export interface ClaimCreatorTokensResult extends WriteResult {
	creatorClaimed: CreatorClaimedEventRaw | null;
}

export interface CreatorWithdrawResult extends WriteResult {
	creatorReclaim: CreatorReclaimEventRaw | null;
}

export interface WithdrawPendingResult extends WriteResult {
	creatorWithdraw: { creator: string; tokenAmount: bigint } | null;
}

export interface PausedChangedResult extends WriteResult {
	pausedChanged: PausedChangedEventRaw | null;
}

/** Extra overrides for a buy call — mainly `value` for native payments. */
export interface BuyOpts {
	value?: bigint;
	gasLimit?: bigint;
}

// Explicit signatures for the overloaded `buy` — ethers v6 requires these.
const BUY_4ARG_SIG = 'buy(address[],uint256,uint256,uint256)';
const BUY_5ARG_SIG = 'buy(address[],uint256,uint256,uint256,address)';

// ════════════════════════════════════════════════════════════════════════════
//  Client
// ════════════════════════════════════════════════════════════════════════════

/**
 * Typed wrapper around a single LaunchInstance clone. Handles state machine
 * reads, buy/refund/graduate writes, typed event subscriptions, and daemon
 * change-detection via stateHash().
 *
 * Pattern mirrors TradeRouterClient / PlatformTokenClient:
 *   - constructor(address, signerOrProvider)
 *   - connect(signer) → new instance with the signer attached
 *   - reads return view-shaped data (bigints preserved where unbounded,
 *     timestamps unwrapped to number when safe)
 *   - writes return `{tx, receipt, ...parsedEvents}` using the converters
 *     exported from structure/launchInstance.ts
 */
export class LaunchInstanceClient {
	readonly contract: ethers.Contract;
	private readonly iface = new ethers.Interface(LAUNCH_INSTANCE_CLIENT_ABI);

	constructor(address: string, signerOrProvider: ethers.Signer | ethers.Provider) {
		this.contract = new ethers.Contract(address, LAUNCH_INSTANCE_CLIENT_ABI, signerOrProvider);
	}

	/** Create a new instance connected to a signer (for write operations). */
	connect(signer: ethers.Signer): LaunchInstanceClient {
		return new LaunchInstanceClient(this.contract.target as string, signer);
	}

	// ── Address accessors ─────────────────────────────────

	async factory(): Promise<string> { return this.contract.factory(); }
	async creator(): Promise<string> { return this.contract.creator(); }
	async token(): Promise<string> { return this.contract.token(); }
	async usdt(): Promise<string> { return this.contract.usdt(); }

	// ── State machine ─────────────────────────────────────

	async state(): Promise<LaunchState> {
		return Number(await this.contract.state()) as LaunchState;
	}

	/** Effective state considers deadline + softCap (returns Refunding when deadline passed w/o softCap). */
	async effectiveState(): Promise<LaunchState> {
		return Number(await this.contract.effectiveState()) as LaunchState;
	}

	async paused(): Promise<boolean> {
		return Boolean(await this.contract.paused());
	}

	async preflight(): Promise<PreflightView> {
		const [ready, reason] = await this.contract.preflight();
		const raw: PreflightRaw = { ready: Boolean(ready), reason: String(reason) };
		return toPreflightView(raw);
	}

	/** Cheap state hash for daemon change-detection — poll this, pull full data only on diff. */
	async stateHash(): Promise<string> {
		return this.contract.stateHash();
	}

	// ── Caps / limits ─────────────────────────────────────

	async softCap(): Promise<bigint> { return BigInt(await this.contract.softCap()); }
	async hardCap(): Promise<bigint> { return BigInt(await this.contract.hardCap()); }
	async maxBuyPerWallet(): Promise<bigint> { return BigInt(await this.contract.maxBuyPerWallet()); }
	async minBuyUsdt(): Promise<bigint> { return BigInt(await this.contract.minBuyUsdt()); }

	// ── Curve ─────────────────────────────────────────────

	async curveType(): Promise<CurveType> {
		return Number(await this.contract.curveType()) as CurveType;
	}
	async curveParam1(): Promise<bigint> { return BigInt(await this.contract.curveParam1()); }
	async curveParam2(): Promise<bigint> { return BigInt(await this.contract.curveParam2()); }

	async getCurrentPrice(): Promise<bigint> {
		return BigInt(await this.contract.getCurrentPrice());
	}

	async getCostForTokens(amount: bigint): Promise<bigint> {
		return BigInt(await this.contract.getCostForTokens(amount));
	}

	async getTokensForBase(base: bigint): Promise<bigint> {
		return BigInt(await this.contract.getTokensForBase(base));
	}

	// ── Totals ────────────────────────────────────────────

	async tokensSold(): Promise<bigint> { return BigInt(await this.contract.tokensSold()); }
	async tokensForCurve(): Promise<bigint> { return BigInt(await this.contract.tokensForCurve()); }
	async tokensForLP(): Promise<bigint> { return BigInt(await this.contract.tokensForLP()); }
	async totalBaseRaised(): Promise<bigint> { return BigInt(await this.contract.totalBaseRaised()); }
	async totalBuyFeesCollected(): Promise<bigint> { return BigInt(await this.contract.totalBuyFeesCollected()); }
	async totalTokensRequired(): Promise<bigint> { return BigInt(await this.contract.totalTokensRequired()); }
	async totalTokensDeposited(): Promise<bigint> { return BigInt(await this.contract.totalTokensDeposited()); }
	async totalBuyers(): Promise<number> { return Number(await this.contract.totalBuyers()); }
	async totalPurchases(): Promise<number> { return Number(await this.contract.totalPurchases()); }

	// ── User position ─────────────────────────────────────

	async basePaid(user: string): Promise<bigint> {
		return BigInt(await this.contract.basePaid(user));
	}

	async grossPaid(user: string): Promise<bigint> {
		return BigInt(await this.contract.grossPaid(user));
	}

	async tokensBought(user: string): Promise<bigint> {
		return BigInt(await this.contract.tokensBought(user));
	}

	/** Combined {basePaid, grossPaid, tokensBought} for a single user in one round-trip. */
	async getUserPosition(user: string): Promise<UserPosition> {
		const [base, gross, tokens] = await Promise.all([
			this.contract.basePaid(user),
			this.contract.grossPaid(user),
			this.contract.tokensBought(user),
		]);
		return {
			basePaid: BigInt(base),
			grossPaid: BigInt(gross),
			tokensBought: BigInt(tokens),
		};
	}

	// ── Previews ──────────────────────────────────────────

	async previewBuy(base: bigint): Promise<BuyPreviewRaw> {
		const [tokensOut, fee, priceImpactBps] = await this.contract.previewBuy(base);
		return { tokensOut: BigInt(tokensOut), fee: BigInt(fee), priceImpactBps: BigInt(priceImpactBps) };
	}

	async previewBuyFor(buyer: string, base: bigint): Promise<BuyPreviewRaw> {
		const [tokensOut, fee, priceImpactBps] = await this.contract.previewBuyFor(buyer, base);
		return { tokensOut: BigInt(tokensOut), fee: BigInt(fee), priceImpactBps: BigInt(priceImpactBps) };
	}

	/** Human-formatted preview — pass token/USDT decimals to get a view-shape tuple. */
	async previewBuyView(base: bigint, opts: LaunchViewOpts = {}): Promise<BuyPreviewView> {
		return toBuyPreviewView(await this.previewBuy(base), opts);
	}

	// ── Full info ─────────────────────────────────────────

	/** Raw 15-field getLaunchInfo() tuple unwrapped into a typed struct. */
	async getLaunchInfo(): Promise<LaunchInfoRaw> {
		const r = await this.contract.getLaunchInfo();
		return {
			token: r[0],
			creator: r[1],
			curveType: BigInt(r[2]),
			state: BigInt(r[3]),
			softCap: BigInt(r[4]),
			hardCap: BigInt(r[5]),
			deadline: BigInt(r[6]),
			totalBaseRaised: BigInt(r[7]),
			tokensSold: BigInt(r[8]),
			tokensForCurve: BigInt(r[9]),
			tokensForLP: BigInt(r[10]),
			creatorAllocationBps: BigInt(r[11]),
			currentPrice: BigInt(r[12]),
			usdt: r[13],
			startTimestamp: BigInt(r[14]),
		};
	}

	/** Human-formatted variant — pass decimals to get strings/Dates. */
	async getLaunchInfoView(opts: LaunchViewOpts = {}): Promise<LaunchInfoView> {
		return toLaunchInfoView(await this.getLaunchInfo(), opts);
	}

	// ── Progress / vesting ────────────────────────────────

	async progressBps(): Promise<ProgressBpsNumeric> {
		const [softCapBps, hardCapBps] = await this.contract.progressBps();
		return { softCapBps: Number(softCapBps), hardCapBps: Number(hardCapBps) };
	}

	async progressBpsView(): Promise<ProgressBpsView> {
		const [softCapBps, hardCapBps] = await this.contract.progressBps();
		const raw: ProgressBpsRaw = { softCapBps: BigInt(softCapBps), hardCapBps: BigInt(hardCapBps) };
		return toProgressBpsView(raw);
	}

	async vestingInfo(): Promise<VestingInfoNumeric> {
		const [total, claimed, claimable, nextClaimTimestamp] = await this.contract.vestingInfo();
		return {
			total: BigInt(total),
			claimed: BigInt(claimed),
			claimable: BigInt(claimable),
			nextClaimTimestamp: Number(nextClaimTimestamp),
		};
	}

	async vestingInfoView(tokenDecimals = 18): Promise<VestingInfoView> {
		const [total, claimed, claimable, nextClaimTimestamp] = await this.contract.vestingInfo();
		const raw: VestingInfoRaw = {
			total: BigInt(total),
			claimed: BigInt(claimed),
			claimable: BigInt(claimable),
			nextClaimTimestamp: BigInt(nextClaimTimestamp),
		};
		return toVestingInfoView(raw, tokenDecimals);
	}

	// ── Enumeration ───────────────────────────────────────

	/** Page through on-chain purchase history. */
	async getPurchases(offset = 0, limit = 50): Promise<{ purchases: PurchaseRaw[]; total: number }> {
		const [rows, total] = await this.contract.getPurchases(offset, limit);
		const purchases: PurchaseRaw[] = (rows as unknown[]).map((r) => {
			const row = r as ethers.Result;
			return {
				buyer: row[0] as string,
				baseAmount: BigInt(row[1] as bigint),
				tokensReceived: BigInt(row[2] as bigint),
				fee: BigInt(row[3] as bigint),
				price: BigInt(row[4] as bigint),
				timestamp: BigInt(row[5] as bigint),
			};
		});
		return { purchases, total: Number(total) };
	}

	async getPurchasesView(offset = 0, limit = 50, opts: LaunchViewOpts = {}): Promise<PurchasesPageView> {
		const { purchases, total } = await this.getPurchases(offset, limit);
		return toPurchasesPageView({ purchases, total: BigInt(total) }, opts);
	}

	async getBuyers(offset = 0, limit = 50): Promise<{ buyers: string[]; total: number }> {
		const [buyers, total] = await this.contract.getBuyers(offset, limit);
		return { buyers: [...buyers] as string[], total: Number(total) };
	}

	async getBuyersView(offset = 0, limit = 50): Promise<BuyersPageView> {
		const { buyers, total } = await this.getBuyers(offset, limit);
		return toBuyersPageView({ buyers, total: BigInt(total) });
	}

	// ════════════════════════════════════════════════════════
	//  Writes
	// ════════════════════════════════════════════════════════

	/**
	 * Buy without a referrer. Uses the 4-arg `buy(address[],uint256,uint256,uint256)`
	 * overload via explicit signature syntax (ethers can't resolve overloads by arity alone).
	 *
	 * Native payments: set `opts.value = amountIn` — the contract checks
	 * `msg.value === amountIn` and reverts otherwise. ERC20 payments must leave
	 * value unset (or 0).
	 */
	async buy(
		path: string[],
		amountIn: bigint,
		minUsdtOut: bigint,
		minTokensOut: bigint,
		opts: BuyOpts = {},
	): Promise<BuyResult> {
		const fn = this.contract.getFunction(BUY_4ARG_SIG);
		const overrides: ethers.Overrides = {};
		if (opts.value !== undefined) overrides.value = opts.value;
		if (opts.gasLimit !== undefined) overrides.gasLimit = opts.gasLimit;
		const tx = (await fn(path, amountIn, minUsdtOut, minTokensOut, overrides)) as ethers.TransactionResponse;
		return this._parseBuyReceipt(tx);
	}

	/**
	 * Buy with an attributed referrer. Uses the 5-arg
	 * `buy(address[],uint256,uint256,uint256,address)` overload. Same
	 * native-vs-ERC20 `value` rules as {@link buy}.
	 */
	async buyWithRef(
		path: string[],
		amountIn: bigint,
		minUsdtOut: bigint,
		minTokensOut: bigint,
		ref: string,
		opts: BuyOpts = {},
	): Promise<BuyResult> {
		const fn = this.contract.getFunction(BUY_5ARG_SIG);
		const overrides: ethers.Overrides = {};
		if (opts.value !== undefined) overrides.value = opts.value;
		if (opts.gasLimit !== undefined) overrides.gasLimit = opts.gasLimit;
		const tx = (await fn(path, amountIn, minUsdtOut, minTokensOut, ref, overrides)) as ethers.TransactionResponse;
		return this._parseBuyReceipt(tx);
	}

	async depositTokens(amount: bigint): Promise<DepositTokensResult> {
		const tx = (await this.contract.depositTokens(amount)) as ethers.TransactionResponse;
		const receipt = await tx.wait();
		return {
			tx,
			receipt,
			tokensDeposited: this._findEvent<TokensDepositedEventRaw>(receipt, 'TokensDeposited'),
			launchActivated: this._findEvent<LaunchActivatedEventRaw>(receipt, 'LaunchActivated'),
		};
	}

	async activate(): Promise<ActivateResult> {
		const tx = (await this.contract.activate()) as ethers.TransactionResponse;
		const receipt = await tx.wait();
		return {
			tx,
			receipt,
			launchActivated: this._findEvent<LaunchActivatedEventRaw>(receipt, 'LaunchActivated'),
		};
	}

	async withdrawPendingTokens(): Promise<WithdrawPendingResult> {
		const tx = (await this.contract.withdrawPendingTokens()) as ethers.TransactionResponse;
		const receipt = await tx.wait();
		return {
			tx,
			receipt,
			creatorWithdraw: this._findEvent<{ creator: string; tokenAmount: bigint }>(receipt, 'CreatorWithdraw'),
		};
	}

	/**
	 * Refund partial or full position during Refunding (or while paused).
	 *
	 * Caller must have approved this contract to pull `tokensToReturn` of the
	 * launch token before calling — use the returned {@link ensureRefundApproval}
	 * helper to wire that up.
	 */
	async refund(tokensToReturn: bigint): Promise<RefundResult> {
		const tx = (await this.contract.refund(tokensToReturn)) as ethers.TransactionResponse;
		const receipt = await tx.wait();
		return {
			tx,
			receipt,
			refunded: this._findEvent<RefundedEventRaw>(receipt, 'Refunded'),
		};
	}

	/**
	 * Approve the launch instance to pull `amount` of the launch token from
	 * `ownerSigner`. No-op if the existing allowance already covers `amount`.
	 * Returns the approval tx receipt or null when already approved.
	 */
	async ensureRefundApproval(ownerSigner: ethers.Signer, amount: bigint): Promise<ethers.TransactionReceipt | null> {
		const tokenAddr = await this.contract.token();
		const erc20 = new ethers.Contract(
			tokenAddr,
			[
				'function allowance(address,address) view returns (uint256)',
				'function approve(address,uint256) returns (bool)',
			],
			ownerSigner,
		);
		const owner = await ownerSigner.getAddress();
		const current: bigint = BigInt(await erc20.allowance(owner, this.contract.target as string));
		if (current >= amount) return null;
		const tx = (await erc20.approve(this.contract.target as string, amount)) as ethers.TransactionResponse;
		return tx.wait();
	}

	async graduate(): Promise<GraduateResult> {
		const tx = (await this.contract.graduate()) as ethers.TransactionResponse;
		const receipt = await tx.wait();
		return {
			tx,
			receipt,
			graduated: this._findEvent<GraduatedEventRaw>(receipt, 'Graduated'),
		};
	}

	/** Creator reclaims whatever launch tokens the contract currently holds (during Refunding). */
	async creatorWithdrawAvailable(): Promise<CreatorWithdrawResult> {
		const tx = (await this.contract.creatorWithdrawAvailable()) as ethers.TransactionResponse;
		const receipt = await tx.wait();
		return {
			tx,
			receipt,
			creatorReclaim: this._findEvent<CreatorReclaimEventRaw>(receipt, 'CreatorReclaim'),
		};
	}

	async claimCreatorTokens(): Promise<ClaimCreatorTokensResult> {
		const tx = (await this.contract.claimCreatorTokens()) as ethers.TransactionResponse;
		const receipt = await tx.wait();
		return {
			tx,
			receipt,
			creatorClaimed: this._findEvent<CreatorClaimedEventRaw>(receipt, 'CreatorClaimed'),
		};
	}

	/** Platform-only — reverts for non-platformWallet callers. Exposed for completeness. */
	async sweepStrandedUsdt(): Promise<WriteResult> {
		const tx = (await this.contract.sweepStrandedUsdt()) as ethers.TransactionResponse;
		const receipt = await tx.wait();
		return { tx, receipt };
	}

	/** Permissionless — triggers _autoResolve() and moves Active→Refunding when soft cap is missed after deadline. */
	async resolveState(): Promise<WriteResult> {
		const tx = (await this.contract.resolveState()) as ethers.TransactionResponse;
		const receipt = await tx.wait();
		return { tx, receipt };
	}

	/** Recover accidentally-sent native coin. Creator or platformWallet only. */
	async recoverETH(): Promise<WriteResult> {
		const tx = (await this.contract.recoverETH()) as ethers.TransactionResponse;
		const receipt = await tx.wait();
		return { tx, receipt };
	}

	/** Factory-only emergency pause. Most callers will never be authorized. */
	async setPaused(paused: boolean): Promise<PausedChangedResult> {
		const tx = (await this.contract.setPaused(paused)) as ethers.TransactionResponse;
		const receipt = await tx.wait();
		return {
			tx,
			receipt,
			pausedChanged: this._findEvent<PausedChangedEventRaw>(receipt, 'PausedChanged'),
		};
	}

	// ════════════════════════════════════════════════════════
	//  Events — typed subscriptions
	//
	//  Every handler returns a view-shaped struct (dates, formatted strings)
	//  by running the raw ethers output through the converter. Callers pass
	//  decimals via the opts param when relevant; we default to 18/18.
	//
	//  Each method returns an unsubscribe function.
	// ════════════════════════════════════════════════════════

	onTokenBought(cb: (ev: TokenBoughtEventView) => void, opts: LaunchViewOpts = {}): () => void {
		const handler = (
			buyer: string,
			tokenAmount: bigint,
			basePaid: bigint,
			fee: bigint,
			newPrice: bigint,
			totalBaseRaised: bigint,
			totalTokensSold: bigint,
			remainingTokens: bigint,
			buyerCount: bigint,
		) => {
			cb(toTokenBoughtEventView({
				buyer, tokenAmount, basePaid, fee, newPrice,
				totalBaseRaised, totalTokensSold, remainingTokens, buyerCount,
			}, opts));
		};
		this.contract.on('TokenBought', handler);
		return () => { this.contract.off('TokenBought', handler); };
	}

	onGraduated(cb: (ev: GraduatedEventView) => void, opts: LaunchViewOpts = {}): () => void {
		const handler = (
			dexPair: string,
			baseToLP: bigint,
			tokensToLP: bigint,
			platformBaseFee: bigint,
			platformTokenFee: bigint,
			finalTotalRaised: bigint,
			finalTokensSold: bigint,
			totalBuyers: bigint,
		) => {
			cb(toGraduatedEventView({
				dexPair, baseToLP, tokensToLP,
				platformBaseFee, platformTokenFee,
				finalTotalRaised, finalTokensSold, totalBuyers,
			}, opts));
		};
		this.contract.on('Graduated', handler);
		return () => { this.contract.off('Graduated', handler); };
	}

	onRefunded(cb: (ev: RefundedEventView) => void, opts: LaunchViewOpts = {}): () => void {
		const handler = (buyer: string, baseAmount: bigint, tokensReturned: bigint) => {
			cb(toRefundedEventView({ buyer, baseAmount, tokensReturned }, opts));
		};
		this.contract.on('Refunded', handler);
		return () => { this.contract.off('Refunded', handler); };
	}

	onCreatorClaimed(cb: (ev: CreatorClaimedEventView) => void, tokenDecimals = 18): () => void {
		const handler = (creator: string, amount: bigint, totalClaimed: bigint, totalVested: bigint) => {
			cb(toCreatorClaimedEventView({ creator, amount, totalClaimed, totalVested }, tokenDecimals));
		};
		this.contract.on('CreatorClaimed', handler);
		return () => { this.contract.off('CreatorClaimed', handler); };
	}

	onRefundingEnabled(cb: (ev: RefundingEnabledEventView) => void, usdtDecimals = 18): () => void {
		const handler = (token: string, totalRaised: bigint, softCap: bigint) => {
			cb(toRefundingEnabledEventView({ token, totalRaised, softCap }, usdtDecimals));
		};
		this.contract.on('RefundingEnabled', handler);
		return () => { this.contract.off('RefundingEnabled', handler); };
	}

	onTokensDeposited(cb: (ev: TokensDepositedEventView) => void, tokenDecimals = 18): () => void {
		const handler = (creator: string, amount: bigint, totalDeposited: bigint, totalRequired: bigint) => {
			cb(toTokensDepositedEventView({ creator, amount, totalDeposited, totalRequired }, tokenDecimals));
		};
		this.contract.on('TokensDeposited', handler);
		return () => { this.contract.off('TokensDeposited', handler); };
	}

	onLaunchActivated(cb: (ev: LaunchActivatedEventView) => void, opts: LaunchViewOpts = {}): () => void {
		const handler = (
			token: string,
			deadline: bigint,
			softCap: bigint,
			hardCap: bigint,
			tokensForCurve: bigint,
		) => {
			cb(toLaunchActivatedEventView({ token, deadline, softCap, hardCap, tokensForCurve }, opts));
		};
		this.contract.on('LaunchActivated', handler);
		return () => { this.contract.off('LaunchActivated', handler); };
	}

	onPausedChanged(cb: (ev: PausedChangedEventView) => void): () => void {
		const handler = (paused: boolean) => { cb({ paused: Boolean(paused) }); };
		this.contract.on('PausedChanged', handler);
		return () => { this.contract.off('PausedChanged', handler); };
	}

	/**
	 * Subscribe to creator-reclaim-unsold events. These are emitted as
	 * `CreatorReclaim` by the contract (creator pulling tokens back during
	 * Refunding — both unsold curve tokens and returned refund tokens).
	 */
	onCreatorReclaimUnsold(cb: (ev: CreatorReclaimEventView) => void, tokenDecimals = 18): () => void {
		const handler = (creator: string, tokenAmount: bigint) => {
			cb(toCreatorReclaimEventView({ creator, tokenAmount }, tokenDecimals));
		};
		this.contract.on('CreatorReclaim', handler);
		return () => { this.contract.off('CreatorReclaim', handler); };
	}

	// ════════════════════════════════════════════════════════
	//  Internal helpers
	// ════════════════════════════════════════════════════════

	/**
	 * Scan a receipt's logs for the first occurrence of `eventName` and
	 * return the parsed args cast to the caller's expected shape. Returns
	 * null when the event wasn't emitted (common when the write reverted
	 * silently or simply didn't trigger the event).
	 */
	private _findEvent<T>(receipt: ethers.TransactionReceipt | null, eventName: string): T | null {
		if (!receipt) return null;
		for (const log of receipt.logs) {
			try {
				const parsed = this.iface.parseLog({ topics: [...log.topics], data: log.data });
				if (parsed?.name === eventName) {
					return parsed.args as unknown as T;
				}
			} catch {
				// Non-matching log from a different contract — skip.
			}
		}
		return null;
	}

	private async _parseBuyReceipt(tx: ethers.TransactionResponse): Promise<BuyResult> {
		const receipt = await tx.wait();
		return {
			tx,
			receipt,
			tokenBought: this._findEvent<TokenBoughtEventRaw>(receipt, 'TokenBought'),
			graduated: this._findEvent<GraduatedEventRaw>(receipt, 'Graduated'),
		};
	}
}

// ════════════════════════════════════════════════════════════════════════════
//  Re-exports — lets consumers import enum + converter types from the client
//  without having to dip into ./structure/launchInstance directly.
// ════════════════════════════════════════════════════════════════════════════

export { CurveType, LaunchState };
export type {
	LaunchInfoView,
	BuyPreviewView,
	ProgressBpsView,
	VestingInfoView,
	PreflightView,
	PurchaseView,
	PurchasesPageView,
	BuyersPageView,
	TokenBoughtEventView,
	GraduatedEventView,
	RefundedEventView,
	CreatorClaimedEventView,
	RefundingEnabledEventView,
	TokensDepositedEventView,
	LaunchActivatedEventView,
	PausedChangedEventView,
	CreatorReclaimEventView,
};
export { toPurchaseView };
