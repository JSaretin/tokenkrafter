import { ethers } from 'ethers';
import { ERC20_ABI } from '../tokenCrafter';
import {
	toCreateTokenParamsRaw,
	type CreateTokenParams,
	type CreateTokenParamsRaw,
	type ProtectionParams,
	type ProtectionParamsRaw,
	type TaxParams,
	type TaxParamsRaw,
	type FeePayment,
	type LaunchParams,
	type LaunchParamsRaw,
	type ListParams,
	type ListParamsRaw,
	type QuoteFeeRaw,
	type QuoteFeeView,
	toQuoteFeeView,
	toLaunchParamsRaw,
	toListParamsRaw,
	toProtectionParamsRaw,
	toTaxParamsRaw,
} from '../structure/platformRouter';

/**
 * Self-contained ABI for PlatformRouter. Mirrors the PLATFORM_ROUTER_ABI in
 * `../tokenCrafter.ts` but extended with admin surface (pause/unpause, minLiquidity,
 * withdrawStuckTokens, owner, paused view) so the client owns its complete
 * contract view.
 */
const PLATFORM_ROUTER_ABI = [
	// ── Writes: create flows ──
	'function createTokenAndLaunch(tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address[] bases) p, tuple(uint256 tokensForLaunch, uint8 curveType, uint256 softCap, uint256 hardCap, uint256 durationDays, uint256 maxBuyBps, uint256 creatorAllocationBps, uint256 vestingDays, uint256 startTimestamp, uint256 lockDurationAfterListing, uint256 minBuyUsdt) launch, tuple(uint256 maxWalletAmount, uint256 maxTransactionAmount, uint256 cooldownSeconds) protection, tuple(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, address[] taxWallets, uint16[] taxSharesBps) tax, tuple(address[] path, uint256 maxAmountIn) fee, address referral) external payable returns (address tokenAddress, address launchAddress)',
	'function createAndList(tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address[] bases) p, tuple(address[] bases, uint256[] baseAmounts, uint256[] tokenAmounts, bool burnLP, uint256 tradingDelay) list, tuple(uint256 maxWalletAmount, uint256 maxTransactionAmount, uint256 cooldownSeconds) protection, tuple(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, address[] taxWallets, uint16[] taxSharesBps) tax, tuple(address[] path, uint256 maxAmountIn) fee, address referral) external payable returns (address tokenAddress)',
	'function createTokenOnly(tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address[] bases) p, tuple(uint256 maxWalletAmount, uint256 maxTransactionAmount, uint256 cooldownSeconds) protection, tuple(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, address[] taxWallets, uint16[] taxSharesBps) tax, tuple(address[] path, uint256 maxAmountIn) fee, address referral) external payable returns (address tokenAddress)',
	'function launchCreatedToken(address tokenAddress, tuple(uint256 tokensForLaunch, uint8 curveType, uint256 softCap, uint256 hardCap, uint256 durationDays, uint256 maxBuyBps, uint256 creatorAllocationBps, uint256 vestingDays, uint256 startTimestamp, uint256 lockDurationAfterListing, uint256 minBuyUsdt) launch, tuple(uint256 maxWalletAmount, uint256 maxTransactionAmount, uint256 cooldownSeconds) protection, tuple(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, address[] taxWallets, uint16[] taxSharesBps) tax, bool isTaxable, tuple(address[] path, uint256 maxAmountIn) fee) external payable returns (address launchAddress)',
	'function addLiquidityToExisting(address tokenAddress, tuple(address[] bases, uint256[] baseAmounts, uint256[] tokenAmounts, bool burnLP, uint256 tradingDelay) list) external payable',

	// ── Views ──
	'function usdt() view returns (address)',
	'function tokenFactory() view returns (address)',
	'function launchpadFactory() view returns (address)',
	'function dexRouter() view returns (address)',
	'function owner() view returns (address)',
	'function paused() view returns (bool)',
	'function minLiquidity() view returns (uint256)',
	'function quoteFee(uint8 typeKey, bool withLaunch, address[] path) view returns (uint256 usdtFee, uint256 amountIn)',

	// ── Admin ──
	'function pause() external',
	'function unpause() external',
	'function setMinLiquidity(uint256 amount) external',
	'function withdrawStuckTokens(address token) external',
	'function transferOwnership(address newOwner) external',
	'function renounceOwnership() external',

	// ── Events ──
	'event TokenCreatedAndLaunched(address indexed creator, address indexed token, address indexed launch)',
	'event TokenLaunched(address indexed creator, address indexed token, address indexed launch)',
	'event TokenCreatedAndListed(address indexed creator, address indexed token, uint256 poolCount, bool lpBurned)',
	'event TokenCreated(address indexed creator, address indexed token)',
	'event TokenListed(address indexed owner, address indexed token, uint256 poolCount, bool lpBurned)',
	'event LiquidityBurned(address indexed token, address indexed pair, uint256 lpAmount)',
	'event Paused(address account)',
	'event Unpaused(address account)',
	'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
] as const;

// ════════════════════════════════════════════════════════════════════════════
//  Public result / param shapes
// ════════════════════════════════════════════════════════════════════════════

export type Unsubscribe = () => void;

export interface TxResult {
	tx: ethers.TransactionResponse;
	receipt: ethers.TransactionReceipt | null;
}

/** Return of `createAndList` — token address + parsed pool count + LP burn flag. */
export interface CreateAndListResult extends TxResult {
	tokenAddress: string;
	poolCount: number;
	lpBurned: boolean;
	/** Pair addresses from `LiquidityBurned` logs (only populated when burnLP = true). */
	burnedPairs: string[];
}

export interface CreateTokenAndLaunchResult extends TxResult {
	tokenAddress: string;
	launchAddress: string;
}

export interface CreateTokenOnlyResult extends TxResult {
	tokenAddress: string;
}

export interface LaunchCreatedTokenResult extends TxResult {
	launchAddress: string;
}

/**
 * Optional call overrides passed to write methods (value, gasLimit, etc).
 * Matches the shape of ethers.Overrides so callers can pass native `value`.
 */
export type CallOverrides = ethers.Overrides & { value?: bigint };

/**
 * Options for `createAndListWithPayment` / `createTokenAndLaunchWithPayment`.
 * When `paymentToken` is unset or equals USDT, the client pre-approves USDT
 * for the quoted fee. For any other token, the caller is responsible for the
 * ERC20 approval path because the fee `path` drives the DEX swap.
 */
export interface PaymentOpts {
	/** Referral address recorded in the token creation. Defaults to ZeroAddress. */
	referral?: string;
	/** Fee path. Defaults to `[usdt]` (direct USDT payment). */
	feePath?: string[];
	/** Max amount of `feePath[0]` the router may pull. Ignored for direct-USDT mode. */
	feeMaxAmountIn?: bigint;
	/** Override the USDT address used for the direct-USDT allowance top-up. */
	paymentToken?: string;
	/** Extra overrides (value for native LP, explicit gasLimit, etc). */
	overrides?: CallOverrides;
}

// Re-export struct types so callers can import from a single module.
export type {
	CreateTokenParams,
	CreateTokenParamsRaw,
	ProtectionParams,
	ProtectionParamsRaw,
	TaxParams,
	TaxParamsRaw,
	FeePayment,
	LaunchParams,
	LaunchParamsRaw,
	ListParams,
	ListParamsRaw,
	QuoteFeeRaw,
	QuoteFeeView,
};

// ════════════════════════════════════════════════════════════════════════════
//  Client
// ════════════════════════════════════════════════════════════════════════════

/**
 * Typed wrapper around the PlatformRouter contract. PlatformRouter is the
 * one-click orchestrator that wraps TokenFactory + LaunchpadFactory + the DEX
 * for compound operations (create + list, create + launch, etc).
 *
 * Constructor takes either a provider (reads only) or a signer (reads + writes).
 * `connect(signer)` returns a new instance bound to the signer.
 */
export class PlatformRouterClient {
	readonly contract: ethers.Contract;
	private readonly iface = new ethers.Interface(PLATFORM_ROUTER_ABI);

	constructor(address: string, signerOrProvider: ethers.Signer | ethers.Provider) {
		this.contract = new ethers.Contract(address, PLATFORM_ROUTER_ABI, signerOrProvider);
	}

	/** Create a new instance connected to a signer (for write operations). */
	connect(signer: ethers.Signer): PlatformRouterClient {
		return new PlatformRouterClient(this.contract.target as string, signer);
	}

	// ── Simple view getters ─────────────────────────────────

	async usdt(): Promise<string> { return this.contract.usdt(); }
	async tokenFactory(): Promise<string> { return this.contract.tokenFactory(); }
	async launchpadFactory(): Promise<string> { return this.contract.launchpadFactory(); }
	async dexRouter(): Promise<string> { return this.contract.dexRouter(); }
	async owner(): Promise<string> { return this.contract.owner(); }
	async paused(): Promise<boolean> { return Boolean(await this.contract.paused()); }
	async minLiquidity(): Promise<bigint> { return BigInt(await this.contract.minLiquidity()); }

	/**
	 * WETH address is not exposed directly on PlatformRouter; fetch via the
	 * DEX router the platform is wired to.
	 */
	async weth(): Promise<string> {
		const dexRouterAddr: string = await this.contract.dexRouter();
		const dex = new ethers.Contract(
			dexRouterAddr,
			['function WETH() view returns (address)'],
			this.contract.runner as ethers.ContractRunner,
		);
		return dex.WETH();
	}

	// ── Fee quoting ─────────────────────────────────────────

	/**
	 * Preview platform fees for a planned action.
	 *
	 * @param typeKey    Token type bitfield (0-7): partner=4 | taxable=2 | mintable=1
	 * @param withLaunch true  = include LaunchpadFactory.launchFee() on top
	 *                   false = creation fee only (createAndList / createTokenOnly flow)
	 * @param path       FeePayment path. Defaults to `[usdt]` (direct-USDT payment, no swap).
	 */
	async quoteFeeRaw(
		typeKey: number,
		withLaunch: boolean,
		path?: string[],
	): Promise<QuoteFeeRaw> {
		this._assertTypeKey(typeKey);
		const usdtAddr = path && path.length > 0 ? undefined : await this.contract.usdt();
		const usedPath = path && path.length > 0 ? path : [usdtAddr as string];
		const [usdtFee, amountIn] = await this.contract.quoteFee(typeKey, withLaunch, usedPath);
		return { usdtFee: BigInt(usdtFee), amountIn: BigInt(amountIn) };
	}

	async quoteFee(
		typeKey: number,
		withLaunch: boolean,
		path?: string[],
		usdtDecimals = 18,
		inputDecimals = 18,
	): Promise<QuoteFeeView> {
		return toQuoteFeeView(await this.quoteFeeRaw(typeKey, withLaunch, path), usdtDecimals, inputDecimals);
	}

	/**
	 * Convenience: total USDT needed for a create-and-list action given token
	 * type flags. Pure view — does NOT include LP seed liquidity or the
	 * launchpad fee (use `quoteFee` with `withLaunch = true` for that).
	 */
	async previewCreationAndListingCost(params: {
		isMintable: boolean;
		isTaxable: boolean;
		isPartner: boolean;
	}): Promise<bigint> {
		const typeKey = PlatformRouterClient.computeTypeKey(
			params.isMintable,
			params.isTaxable,
			params.isPartner,
		);
		const { usdtFee } = await this.quoteFeeRaw(typeKey, false);
		return usdtFee;
	}

	// ── Writes: create flows ────────────────────────────────

	/**
	 * Low-level `createAndList`. Caller is responsible for USDT approval (or
	 * providing a non-USDT fee path + `value` overrides). Use
	 * `createAndListWithPayment` when you want the client to handle USDT
	 * approval automatically.
	 */
	async createAndList(
		p: CreateTokenParams | CreateTokenParamsRaw,
		list: ListParamsRaw,
		protection: ProtectionParamsRaw,
		tax: TaxParamsRaw,
		fee: FeePayment,
		referral: string = ethers.ZeroAddress,
		overrides: CallOverrides = {},
	): Promise<CreateAndListResult> {
		const raw = this._toParamsRaw(p);
		const args = [
			raw,
			this._listTuple(list),
			this._protectionTuple(protection),
			this._taxTuple(tax),
			this._feeTuple(fee),
			referral,
		];
		const est = await this.contract.createAndList.estimateGas(...args, overrides);
		const tx = await this.contract.createAndList(...args, {
			...overrides,
			gasLimit: (est * 130n) / 100n,
		});
		return this._parseCreateAndListReceipt(tx);
	}

	/**
	 * Low-level `createTokenAndLaunch`. Caller is responsible for USDT approval
	 * (or providing a non-USDT fee path + `value` overrides).
	 */
	async createTokenAndLaunch(
		p: CreateTokenParams | CreateTokenParamsRaw,
		launch: LaunchParamsRaw,
		protection: ProtectionParamsRaw,
		tax: TaxParamsRaw,
		fee: FeePayment,
		referral: string = ethers.ZeroAddress,
		overrides: CallOverrides = {},
	): Promise<CreateTokenAndLaunchResult> {
		const raw = this._toParamsRaw(p);
		const args = [
			raw,
			this._launchTuple(launch),
			this._protectionTuple(protection),
			this._taxTuple(tax),
			this._feeTuple(fee),
			referral,
		];
		const est = await this.contract.createTokenAndLaunch.estimateGas(...args, overrides);
		const tx = await this.contract.createTokenAndLaunch(...args, {
			...overrides,
			gasLimit: (est * 130n) / 100n,
		});
		return this._parseCreateTokenAndLaunchReceipt(tx);
	}

	/**
	 * Low-level `createTokenOnly`. No listing, no launch — just the token.
	 */
	async createTokenOnly(
		p: CreateTokenParams | CreateTokenParamsRaw,
		protection: ProtectionParamsRaw,
		tax: TaxParamsRaw,
		fee: FeePayment,
		referral: string = ethers.ZeroAddress,
		overrides: CallOverrides = {},
	): Promise<CreateTokenOnlyResult> {
		const raw = this._toParamsRaw(p);
		const args = [
			raw,
			this._protectionTuple(protection),
			this._taxTuple(tax),
			this._feeTuple(fee),
			referral,
		];
		const est = await this.contract.createTokenOnly.estimateGas(...args, overrides);
		const tx = await this.contract.createTokenOnly(...args, {
			...overrides,
			gasLimit: (est * 130n) / 100n,
		});
		return this._parseCreateTokenOnlyReceipt(tx);
	}

	/**
	 * Launch an already-created platform token. Caller must
	 * `transferOwnership(routerAddress)` on the token BEFORE calling — the
	 * router hands ownership back at the end of the transaction.
	 */
	async launchCreatedToken(
		tokenAddress: string,
		launch: LaunchParamsRaw,
		protection: ProtectionParamsRaw,
		tax: TaxParamsRaw,
		isTaxable: boolean,
		fee: FeePayment,
		overrides: CallOverrides = {},
	): Promise<LaunchCreatedTokenResult> {
		const args = [
			tokenAddress,
			this._launchTuple(launch),
			this._protectionTuple(protection),
			this._taxTuple(tax),
			isTaxable,
			this._feeTuple(fee),
		];
		const est = await this.contract.launchCreatedToken.estimateGas(...args, overrides);
		const tx = await this.contract.launchCreatedToken(...args, {
			...overrides,
			gasLimit: (est * 130n) / 100n,
		});
		return this._parseLaunchCreatedTokenReceipt(tx);
	}

	/**
	 * Add liquidity to an already-created token. Caller must approve the
	 * router for the total token amount (sum of `list.tokenAmounts`) and for
	 * each non-native base amount.
	 */
	async addLiquidityToExisting(
		tokenAddress: string,
		list: ListParamsRaw,
		overrides: CallOverrides = {},
	): Promise<TxResult> {
		const args = [tokenAddress, this._listTuple(list)];
		const est = await this.contract.addLiquidityToExisting.estimateGas(...args, overrides);
		const tx = await this.contract.addLiquidityToExisting(...args, {
			...overrides,
			gasLimit: (est * 130n) / 100n,
		});
		const receipt = await tx.wait();
		return { tx, receipt };
	}

	// ── Writes with automatic fee payment ──────────────────

	/**
	 * Higher-level `createAndList` that auto-approves USDT for the creation
	 * fee. For non-USDT fee paths (e.g. native/BNB or other ERC20), the
	 * caller is expected to pass `overrides.value` (native) or handle the
	 * ERC20 approval separately.
	 *
	 * - If `paymentToken` is unset or equals the router's `usdt()`, the
	 *   method reads the allowance and tops it up to `usdtFee` before the call.
	 * - Otherwise, no allowance work is done — the fee path tells the router
	 *   how to acquire USDT from the caller's input token.
	 */
	async createAndListWithPayment(
		p: CreateTokenParams | CreateTokenParamsRaw,
		list: ListParamsRaw,
		protection: ProtectionParamsRaw,
		tax: TaxParamsRaw,
		opts: PaymentOpts = {},
	): Promise<CreateAndListResult> {
		const raw = this._toParamsRaw(p);
		const { feePayment } = await this._prepPayment(
			PlatformRouterClient.computeTypeKey(raw.isMintable, raw.isTaxable, raw.isPartner),
			false,
			opts,
		);
		return this.createAndList(
			raw,
			list,
			protection,
			tax,
			feePayment,
			opts.referral ?? ethers.ZeroAddress,
			opts.overrides ?? {},
		);
	}

	/**
	 * Higher-level `createTokenAndLaunch` that auto-approves USDT for
	 * creation + launch fees when paying in USDT. Same non-USDT caveat as
	 * `createAndListWithPayment`.
	 */
	async createTokenAndLaunchWithPayment(
		p: CreateTokenParams | CreateTokenParamsRaw,
		launch: LaunchParamsRaw,
		protection: ProtectionParamsRaw,
		tax: TaxParamsRaw,
		opts: PaymentOpts = {},
	): Promise<CreateTokenAndLaunchResult> {
		const raw = this._toParamsRaw(p);
		const { feePayment } = await this._prepPayment(
			PlatformRouterClient.computeTypeKey(raw.isMintable, raw.isTaxable, raw.isPartner),
			true,
			opts,
		);
		return this.createTokenAndLaunch(
			raw,
			launch,
			protection,
			tax,
			feePayment,
			opts.referral ?? ethers.ZeroAddress,
			opts.overrides ?? {},
		);
	}

	// ── Input-shape conversions (decimal-string → raw bigint) ──

	/** Parse a frontend ProtectionParams into the raw struct. */
	static toProtectionParamsRaw(p: ProtectionParams, tokenDecimals: number): ProtectionParamsRaw {
		return toProtectionParamsRaw(p, tokenDecimals);
	}

	/** Parse a frontend TaxParams into the raw struct. */
	static toTaxParamsRaw(p: TaxParams): TaxParamsRaw {
		return toTaxParamsRaw(p);
	}

	/** Parse a frontend LaunchParams into the raw struct. */
	static toLaunchParamsRaw(p: LaunchParams, tokenDecimals: number, usdtDecimals = 18): LaunchParamsRaw {
		return toLaunchParamsRaw(p, tokenDecimals, usdtDecimals);
	}

	/** Parse a frontend ListParams into the raw struct. */
	static toListParamsRaw(p: ListParams, baseDecimals: number[], tokenDecimals: number): ListParamsRaw {
		return toListParamsRaw(p, baseDecimals, tokenDecimals);
	}

	// ── Admin writes ─────────────────────────────────────────

	async pause(setPaused = true): Promise<TxResult> {
		return this._send(setPaused ? 'pause' : 'unpause', []);
	}

	async unpause(): Promise<TxResult> { return this._send('unpause', []); }

	async setMinLiquidity(amount: bigint): Promise<TxResult> {
		return this._send('setMinLiquidity', [amount]);
	}

	/**
	 * Sweep a stuck ERC20 or native balance held by the router to the owner.
	 * Use `ethers.ZeroAddress` for native (BNB/ETH).
	 */
	async withdrawStuckTokens(token: string): Promise<TxResult> {
		return this._send('withdrawStuckTokens', [token]);
	}

	async transferOwnership(newOwner: string): Promise<TxResult> {
		return this._send('transferOwnership', [newOwner]);
	}

	async renounceOwnership(): Promise<TxResult> {
		return this._send('renounceOwnership', []);
	}

	// ── Event subscriptions ──────────────────────────────────

	onTokenCreatedAndLaunched(
		cb: (args: { creator: string; token: string; launch: string }, rawLog: ethers.Log) => void,
	): Unsubscribe {
		const handler = (
			creator: string, token: string, launch: string,
			event: ethers.ContractEventPayload,
		) => { cb({ creator, token, launch }, event.log); };
		this.contract.on('TokenCreatedAndLaunched', handler);
		return () => { this.contract.off('TokenCreatedAndLaunched', handler); };
	}

	onTokenLaunched(
		cb: (args: { creator: string; token: string; launch: string }, rawLog: ethers.Log) => void,
	): Unsubscribe {
		const handler = (
			creator: string, token: string, launch: string,
			event: ethers.ContractEventPayload,
		) => { cb({ creator, token, launch }, event.log); };
		this.contract.on('TokenLaunched', handler);
		return () => { this.contract.off('TokenLaunched', handler); };
	}

	onTokenCreatedAndListed(
		cb: (
			args: { creator: string; token: string; poolCount: number; lpBurned: boolean },
			rawLog: ethers.Log,
		) => void,
	): Unsubscribe {
		const handler = (
			creator: string, token: string, poolCount: bigint, lpBurned: boolean,
			event: ethers.ContractEventPayload,
		) => {
			cb(
				{ creator, token, poolCount: Number(poolCount), lpBurned },
				event.log,
			);
		};
		this.contract.on('TokenCreatedAndListed', handler);
		return () => { this.contract.off('TokenCreatedAndListed', handler); };
	}

	onTokenCreated(
		cb: (args: { creator: string; token: string }, rawLog: ethers.Log) => void,
	): Unsubscribe {
		const handler = (
			creator: string, token: string,
			event: ethers.ContractEventPayload,
		) => { cb({ creator, token }, event.log); };
		this.contract.on('TokenCreated', handler);
		return () => { this.contract.off('TokenCreated', handler); };
	}

	onTokenListed(
		cb: (
			args: { owner: string; token: string; poolCount: number; lpBurned: boolean },
			rawLog: ethers.Log,
		) => void,
	): Unsubscribe {
		const handler = (
			owner: string, token: string, poolCount: bigint, lpBurned: boolean,
			event: ethers.ContractEventPayload,
		) => {
			cb(
				{ owner, token, poolCount: Number(poolCount), lpBurned },
				event.log,
			);
		};
		this.contract.on('TokenListed', handler);
		return () => { this.contract.off('TokenListed', handler); };
	}

	onLiquidityBurned(
		cb: (args: { token: string; pair: string; lpAmount: bigint }, rawLog: ethers.Log) => void,
	): Unsubscribe {
		const handler = (
			token: string, pair: string, lpAmount: bigint,
			event: ethers.ContractEventPayload,
		) => { cb({ token, pair, lpAmount: BigInt(lpAmount) }, event.log); };
		this.contract.on('LiquidityBurned', handler);
		return () => { this.contract.off('LiquidityBurned', handler); };
	}

	onPaused(cb: (account: string, rawLog: ethers.Log) => void): Unsubscribe {
		const handler = (account: string, event: ethers.ContractEventPayload) => {
			cb(account, event.log);
		};
		this.contract.on('Paused', handler);
		return () => { this.contract.off('Paused', handler); };
	}

	onUnpaused(cb: (account: string, rawLog: ethers.Log) => void): Unsubscribe {
		const handler = (account: string, event: ethers.ContractEventPayload) => {
			cb(account, event.log);
		};
		this.contract.on('Unpaused', handler);
		return () => { this.contract.off('Unpaused', handler); };
	}

	// ── Utilities ──────────────────────────────────────────

	/** Type-key bitfield: partner=4, taxable=2, mintable=1. */
	static computeTypeKey(isMintable: boolean, isTaxable: boolean, isPartner: boolean): number {
		return (isPartner ? 4 : 0) | (isTaxable ? 2 : 0) | (isMintable ? 1 : 0);
	}

	// ── Internals ──────────────────────────────────────────

	private _assertTypeKey(typeKey: number): void {
		if (!Number.isInteger(typeKey) || typeKey < 0 || typeKey > 7) {
			throw new Error(`typeKey must be an integer in 0..7 (got ${typeKey})`);
		}
	}

	private _toParamsRaw(p: CreateTokenParams | CreateTokenParamsRaw): CreateTokenParamsRaw {
		if (typeof (p as CreateTokenParamsRaw).totalSupply === 'bigint') {
			return p as CreateTokenParamsRaw;
		}
		return toCreateTokenParamsRaw(p as CreateTokenParams);
	}

	private _protectionTuple(p: ProtectionParamsRaw): [bigint, bigint, bigint] {
		return [p.maxWalletAmount, p.maxTransactionAmount, p.cooldownSeconds];
	}

	private _taxTuple(
		t: TaxParamsRaw,
	): [bigint, bigint, bigint, string[], number[]] {
		return [t.buyTaxBps, t.sellTaxBps, t.transferTaxBps, t.taxWallets, t.taxSharesBps];
	}

	private _feeTuple(fee: FeePayment): [string[], bigint] {
		return [fee.path, fee.maxAmountIn];
	}

	private _launchTuple(
		l: LaunchParamsRaw,
	): [bigint, number, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint] {
		return [
			l.tokensForLaunch,
			l.curveType,
			l.softCap,
			l.hardCap,
			l.durationDays,
			l.maxBuyBps,
			l.creatorAllocationBps,
			l.vestingDays,
			l.startTimestamp,
			l.lockDurationAfterListing,
			l.minBuyUsdt,
		];
	}

	private _listTuple(l: ListParamsRaw): [string[], bigint[], bigint[], boolean, bigint] {
		return [l.bases, l.baseAmounts, l.tokenAmounts, l.burnLP, l.tradingDelay];
	}

	/**
	 * Shared helper for the *WithPayment helpers: quotes the USDT fee, builds
	 * a FeePayment, and (for direct-USDT mode) tops up the router allowance.
	 */
	private async _prepPayment(
		typeKey: number,
		withLaunch: boolean,
		opts: PaymentOpts,
	): Promise<{ feePayment: FeePayment; usdtFee: bigint }> {
		const usdtAddr: string = opts.paymentToken ?? await this.contract.usdt();
		const path = opts.feePath && opts.feePath.length > 0 ? opts.feePath : [usdtAddr];
		const maxAmountIn = opts.feeMaxAmountIn ?? 0n;

		const { usdtFee } = await this.quoteFeeRaw(typeKey, withLaunch, path);

		const isDirectUsdt = path.length === 1 && path[0].toLowerCase() === usdtAddr.toLowerCase();

		if (isDirectUsdt && usdtFee > 0n) {
			const runner = this.contract.runner;
			if (!runner || !('sendTransaction' in runner)) {
				throw new Error('createAndListWithPayment / createTokenAndLaunchWithPayment requires a signer');
			}
			const signer = runner as ethers.Signer;
			const signerAddr = await signer.getAddress();
			const routerAddr = this.contract.target as string;

			const usdt = new ethers.Contract(usdtAddr, ERC20_ABI, signer);
			const current: bigint = await usdt.allowance(signerAddr, routerAddr);
			if (current < usdtFee) {
				const approveTx = await usdt.approve(routerAddr, usdtFee);
				await approveTx.wait();
			}
		}

		return { feePayment: { path, maxAmountIn }, usdtFee };
	}

	private async _send(method: string, args: unknown[]): Promise<TxResult> {
		const fn = this.contract[method] as ethers.BaseContractMethod;
		const tx = (await fn(...args)) as ethers.TransactionResponse;
		const receipt = await tx.wait();
		return { tx, receipt };
	}

	private async _parseCreateAndListReceipt(
		tx: ethers.TransactionResponse,
	): Promise<CreateAndListResult> {
		const receipt = await tx.wait();
		let tokenAddress = ethers.ZeroAddress;
		let poolCount = 0;
		let lpBurned = false;
		const burnedPairs: string[] = [];

		for (const log of receipt?.logs || []) {
			try {
				const parsed = this.iface.parseLog({ topics: [...log.topics], data: log.data });
				if (!parsed) continue;
				if (parsed.name === 'TokenCreatedAndListed') {
					tokenAddress = parsed.args.token as string;
					poolCount = Number(parsed.args.poolCount);
					lpBurned = Boolean(parsed.args.lpBurned);
				} else if (parsed.name === 'LiquidityBurned') {
					burnedPairs.push(parsed.args.pair as string);
				}
			} catch { /* not our event */ }
		}

		return { tx, receipt, tokenAddress, poolCount, lpBurned, burnedPairs };
	}

	private async _parseCreateTokenAndLaunchReceipt(
		tx: ethers.TransactionResponse,
	): Promise<CreateTokenAndLaunchResult> {
		const receipt = await tx.wait();
		let tokenAddress = ethers.ZeroAddress;
		let launchAddress = ethers.ZeroAddress;

		for (const log of receipt?.logs || []) {
			try {
				const parsed = this.iface.parseLog({ topics: [...log.topics], data: log.data });
				if (parsed?.name === 'TokenCreatedAndLaunched') {
					tokenAddress = parsed.args.token as string;
					launchAddress = parsed.args.launch as string;
					break;
				}
			} catch { /* not our event */ }
		}

		return { tx, receipt, tokenAddress, launchAddress };
	}

	private async _parseCreateTokenOnlyReceipt(
		tx: ethers.TransactionResponse,
	): Promise<CreateTokenOnlyResult> {
		const receipt = await tx.wait();
		let tokenAddress = ethers.ZeroAddress;

		for (const log of receipt?.logs || []) {
			try {
				const parsed = this.iface.parseLog({ topics: [...log.topics], data: log.data });
				if (parsed?.name === 'TokenCreated') {
					tokenAddress = parsed.args.token as string;
					break;
				}
			} catch { /* not our event */ }
		}

		return { tx, receipt, tokenAddress };
	}

	private async _parseLaunchCreatedTokenReceipt(
		tx: ethers.TransactionResponse,
	): Promise<LaunchCreatedTokenResult> {
		const receipt = await tx.wait();
		let launchAddress = ethers.ZeroAddress;

		for (const log of receipt?.logs || []) {
			try {
				const parsed = this.iface.parseLog({ topics: [...log.topics], data: log.data });
				if (parsed?.name === 'TokenLaunched') {
					launchAddress = parsed.args.launch as string;
					break;
				}
			} catch { /* not our event */ }
		}

		return { tx, receipt, launchAddress };
	}
}
