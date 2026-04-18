import { ethers } from 'ethers';
import {
	toFactoryStateView,
	toLaunchCreatedEventView,
	toLaunchFeePaidEventView,
	toLaunchesPausedEventView,
	type CurveDefaultsRaw,
	type CurveDefaultsView,
	type LaunchDayStatsRaw,
	type LaunchDayStatsView,
	type FactoryStateRaw,
	type FactoryStateView,
	type CreateLaunchParams,
	type CreateLaunchCustomCurveParams,
	type LaunchCreatedEventRaw,
	type LaunchCreatedEventView,
	type LaunchFeePaidEventRaw,
	type LaunchFeePaidEventView,
	type PlatformWalletUpdatedEventRaw,
	type DexRouterUpdatedEventRaw,
	type AuthorizedRouterUpdatedEventRaw,
	type AffiliateUpdatedEventRaw,
	type GlobalPauseChangedEventRaw,
	type LaunchPausedEventRaw,
	type LaunchesPausedEventRaw,
	type LaunchesPausedEventView,
	type CurveDefaultsUpdatedEventRaw,
} from './structure/launchpadFactory';
import { toCurveDefaultsView, toLaunchDayStatsView } from './structure/launchpadFactory';

/**
 * Self-contained ABI for LaunchpadFactory. The legacy ABI in `./launchpad` is
 * missing recent surface (predictLaunchAddress, pauses, affiliate, dailyLaunchStats,
 * full event set). Keeping it local means this client owns its own contract view.
 */
const LAUNCHPAD_FACTORY_ABI = [
	// ── Reads ──
	'function owner() view returns (address)',
	'function platformWallet() view returns (address)',
	'function dexRouter() view returns (address)',
	'function usdt() view returns (address)',
	'function launchImplementation() view returns (address)',
	'function launchFee() view returns (uint256)',
	'function authorizedRouter() view returns (address)',
	'function affiliate() view returns (address)',
	'function globalPause() view returns (bool)',
	'function totalLaunchFeeEarnedUsdt() view returns (uint256)',
	'function curveDefaults() view returns (uint256 linearSlope, uint256 linearIntercept, uint256 sqrtCoefficient, uint256 quadraticCoefficient, uint256 expBase, uint256 expKFactor)',
	'function totalLaunches() view returns (uint256)',
	'function launches(uint256) view returns (address)',
	'function getLaunchByIndex(uint256 index) view returns (address)',
	'function getLaunches(uint256 offset, uint256 limit) view returns (address[] r, uint256 total)',
	'function getCreatorLaunches(address creator_) view returns (address[])',
	'function tokenToLaunch(address token_) view returns (address)',
	'function dailyLaunchStats(uint256) view returns (uint256 created, uint256 graduated, uint256 totalFeeUsdt)',
	'function predictLaunchAddress(address creator_, address token_, uint256 userSalt) view returns (address)',
	'function getState() view returns (address factoryOwner, uint256 totalLaunchCount, uint256 totalFeeUsdt, uint256 fee)',

	// ── Writes ──
	'function createLaunch(address token_, uint256 totalTokens_, uint8 curveType_, uint256 softCap_, uint256 hardCap_, uint256 durationDays_, uint256 maxBuyBps_, uint256 creatorAllocationBps_, uint256 vestingDays_, uint256 startTimestamp_, uint256 lockDurationAfterListing_, uint256 minBuyUsdt_) external returns (address)',
	'function createLaunchCustomCurve(address token_, uint256 totalTokens_, uint8 curveType_, uint256 curveParam1_, uint256 curveParam2_, uint256 softCap_, uint256 hardCap_, uint256 durationDays_, uint256 maxBuyBps_, uint256 creatorAllocationBps_, uint256 vestingDays_, uint256 startTimestamp_, uint256 lockDurationAfterListing_, uint256 minBuyUsdt_) external returns (address)',
	'function cancelPendingLaunch(address token_) external',

	// ── Admin writes ──
	'function setPlatformWallet(address wallet_) external',
	'function setDexRouter(address router_) external',
	'function setLaunchImplementation(address impl_) external',
	'function setUsdt(address usdt_) external',
	'function setLaunchFee(uint256 fee_) external',
	'function setCurveDefaults(tuple(uint256 linearSlope, uint256 linearIntercept, uint256 sqrtCoefficient, uint256 quadraticCoefficient, uint256 expBase, uint256 expKFactor) defaults_) external',
	'function setAuthorizedRouter(address router_) external',
	'function setAffiliate(address aff) external',
	'function setGlobalPause(bool paused_) external',
	'function pauseLaunch(address launch_, bool paused_) external',
	'function pauseLaunches(uint256 offset, uint256 limit, bool paused_) external',
	'function withdrawFees(address token_) external',

	// ── Events ──
	'event LaunchCreated(address indexed launch, address indexed token, address indexed creator, uint8 curveType, uint256 softCap, uint256 hardCap, uint256 totalTokens, uint256 param1, uint256 param2)',
	'event PlatformWalletUpdated(address newWallet)',
	'event DexRouterUpdated(address newRouter)',
	'event CurveDefaultsUpdated()',
	'event LaunchFeeUpdated(uint256 newFee)',
	'event LaunchFeePaid(address indexed payer, uint256 amount)',
	'event AuthorizedRouterUpdated(address newRouter)',
	'event AffiliateUpdated(address indexed previous, address indexed current)',
	'event GlobalPauseChanged(bool paused)',
	'event LaunchPaused(address indexed launch, bool paused)',
	'event LaunchesPaused(uint256 fromIndex, uint256 toIndex, bool paused)',
];

// ════════════════════════════════════════════════════════════════════════════
//  Public result types
// ════════════════════════════════════════════════════════════════════════════

export interface LaunchCreationResult {
	tx: ethers.TransactionResponse;
	receipt: ethers.TransactionReceipt | null;
	launchAddress: string;
}

export interface TxResult {
	tx: ethers.TransactionResponse;
	receipt: ethers.TransactionReceipt | null;
}

export type Unsubscribe = () => void;

// Re-export param interfaces so consumers can import from a single file.
export type { CreateLaunchParams, CreateLaunchCustomCurveParams, CurveDefaultsView, LaunchDayStatsView, FactoryStateView };

// ════════════════════════════════════════════════════════════════════════════
//  Client
// ════════════════════════════════════════════════════════════════════════════

/**
 * Typed wrapper around the LaunchpadFactory contract. Mirrors the TradeRouterClient
 * pattern: simple read getters, write methods that return `{tx, receipt, ...}`,
 * and typed event subscriptions that return an unsubscribe fn.
 */
export class LaunchpadFactoryClient {
	readonly contract: ethers.Contract;
	private readonly iface = new ethers.Interface(LAUNCHPAD_FACTORY_ABI);

	constructor(address: string, signerOrProvider: ethers.Signer | ethers.Provider) {
		this.contract = new ethers.Contract(address, LAUNCHPAD_FACTORY_ABI, signerOrProvider);
	}

	/** Create a new instance connected to a signer (for write operations) */
	connect(signer: ethers.Signer): LaunchpadFactoryClient {
		return new LaunchpadFactoryClient(this.contract.target as string, signer);
	}

	// ── Simple getters ─────────────────────────────────────

	async owner(): Promise<string> { return this.contract.owner(); }
	async platformWallet(): Promise<string> { return this.contract.platformWallet(); }
	async dexRouter(): Promise<string> { return this.contract.dexRouter(); }
	async usdt(): Promise<string> { return this.contract.usdt(); }
	async launchImplementation(): Promise<string> { return this.contract.launchImplementation(); }
	async authorizedRouter(): Promise<string> { return this.contract.authorizedRouter(); }
	async affiliate(): Promise<string> { return this.contract.affiliate(); }

	async launchFee(): Promise<bigint> { return BigInt(await this.contract.launchFee()); }
	async globalPause(): Promise<boolean> { return Boolean(await this.contract.globalPause()); }

	// ── Curve defaults ─────────────────────────────────────

	/** Raw struct — 18-decimal curve-math units. */
	async curveDefaultsRaw(): Promise<CurveDefaultsRaw> {
		const r = await this.contract.curveDefaults();
		return {
			linearSlope: BigInt(r.linearSlope),
			linearIntercept: BigInt(r.linearIntercept),
			sqrtCoefficient: BigInt(r.sqrtCoefficient),
			quadraticCoefficient: BigInt(r.quadraticCoefficient),
			expBase: BigInt(r.expBase),
			expKFactor: BigInt(r.expKFactor),
		};
	}

	/** View-formatted (strings at 18 decimals). */
	async curveDefaults(): Promise<CurveDefaultsView> {
		return toCurveDefaultsView(await this.curveDefaultsRaw());
	}

	// ── Launches enumeration ───────────────────────────────

	async totalLaunches(): Promise<number> {
		return Number(await this.contract.totalLaunches());
	}

	async getLaunchByIndex(index: number): Promise<string> {
		return this.contract.getLaunchByIndex(BigInt(index));
	}

	async getLaunches(offset = 0, limit = 50): Promise<string[]> {
		const [r] = await this.contract.getLaunches(BigInt(offset), BigInt(limit));
		return [...r];
	}

	async getCreatorLaunches(creator: string): Promise<string[]> {
		const r = await this.contract.getCreatorLaunches(creator);
		return [...r];
	}

	/** Returns the launch address mapped to `token`, or `ZeroAddress` if none. */
	async tokenToLaunch(token: string): Promise<string> {
		return this.contract.tokenToLaunch(token);
	}

	async predictLaunchAddress(creator: string, token: string, userSalt: bigint | number | string): Promise<string> {
		return this.contract.predictLaunchAddress(creator, token, BigInt(userSalt));
	}

	// ── Stats ──────────────────────────────────────────────

	async dailyLaunchStatsRaw(day: number | bigint): Promise<LaunchDayStatsRaw> {
		const r = await this.contract.dailyLaunchStats(BigInt(day));
		return {
			created: BigInt(r.created ?? r[0]),
			graduated: BigInt(r.graduated ?? r[1]),
			totalFeeUsdt: BigInt(r.totalFeeUsdt ?? r[2]),
		};
	}

	async dailyLaunchStats(day: number | bigint, usdtDecimals = 18): Promise<LaunchDayStatsView> {
		return toLaunchDayStatsView(await this.dailyLaunchStatsRaw(day), usdtDecimals);
	}

	/** Aggregate state view (owner, total launches, total fees, current fee). */
	async getState(usdtDecimals = 18): Promise<FactoryStateView> {
		const r = await this.contract.getState();
		const raw: FactoryStateRaw = {
			factoryOwner: r.factoryOwner ?? r[0],
			totalLaunchCount: BigInt(r.totalLaunchCount ?? r[1]),
			totalFeeUsdt: BigInt(r.totalFeeUsdt ?? r[2]),
			fee: BigInt(r.fee ?? r[3]),
		};
		return toFactoryStateView(raw, usdtDecimals);
	}

	// ── Launch creation ────────────────────────────────────

	/**
	 * Create a launch with default curve params. Caller must have approved
	 * the factory for `launchFee` USDT beforehand.
	 *
	 * `params` accepts raw bigints — the caller is expected to have already
	 * parsed user-facing decimal strings via ethers.parseUnits (or via the
	 * converters in `./structure/launchpadFactory`). Kept raw here so we
	 * don't double-parse if callers are already working in bigint.
	 */
	async createLaunch(params: CreateLaunchRawInput): Promise<LaunchCreationResult> {
		const args = this._createLaunchArgs(params);
		const est = await this.contract.createLaunch.estimateGas(...args);
		const tx = await this.contract.createLaunch(...args, { gasLimit: (est * 130n) / 100n });
		return this._parseLaunchCreated(tx);
	}

	/** Create a launch with creator-supplied curve params (18-decimal units). */
	async createLaunchCustomCurve(params: CreateLaunchCustomCurveRawInput): Promise<LaunchCreationResult> {
		const args = this._createLaunchCustomCurveArgs(params);
		const est = await this.contract.createLaunchCustomCurve.estimateGas(...args);
		const tx = await this.contract.createLaunchCustomCurve(...args, { gasLimit: (est * 130n) / 100n });
		return this._parseLaunchCreated(tx);
	}

	async cancelPendingLaunch(token: string): Promise<TxResult> {
		const tx = await this.contract.cancelPendingLaunch(token);
		const receipt = await tx.wait();
		return { tx, receipt };
	}

	// ── Admin writes ───────────────────────────────────────

	async setPlatformWallet(addr: string): Promise<TxResult> { return this._send('setPlatformWallet', [addr]); }
	async setDexRouter(addr: string): Promise<TxResult> { return this._send('setDexRouter', [addr]); }
	async setLaunchImplementation(addr: string): Promise<TxResult> { return this._send('setLaunchImplementation', [addr]); }
	async setUsdt(addr: string): Promise<TxResult> { return this._send('setUsdt', [addr]); }
	async setLaunchFee(fee: bigint): Promise<TxResult> { return this._send('setLaunchFee', [fee]); }
	async setCurveDefaults(defaults: CurveDefaultsRaw): Promise<TxResult> {
		return this._send('setCurveDefaults', [[
			defaults.linearSlope,
			defaults.linearIntercept,
			defaults.sqrtCoefficient,
			defaults.quadraticCoefficient,
			defaults.expBase,
			defaults.expKFactor,
		]]);
	}
	async setAuthorizedRouter(addr: string): Promise<TxResult> { return this._send('setAuthorizedRouter', [addr]); }
	async setAffiliate(addr: string): Promise<TxResult> { return this._send('setAffiliate', [addr]); }

	async setGlobalPause(paused: boolean): Promise<TxResult> { return this._send('setGlobalPause', [paused]); }
	async pauseLaunch(launch: string, paused: boolean): Promise<TxResult> { return this._send('pauseLaunch', [launch, paused]); }
	async pauseLaunches(offset: number, limit: number, paused: boolean): Promise<TxResult> {
		return this._send('pauseLaunches', [BigInt(offset), BigInt(limit), paused]);
	}

	/** Sweep accumulated fees of `token` to the configured platform wallet. */
	async withdrawFees(token: string): Promise<TxResult> { return this._send('withdrawFees', [token]); }

	// ── Event subscriptions ────────────────────────────────

	/** Parsed LaunchCreated. Returns an unsubscribe fn. */
	onLaunchCreated(
		cb: (view: LaunchCreatedEventView, raw: LaunchCreatedEventRaw) => void,
		opts: { tokenDecimals?: number; usdtDecimals?: number } = {}
	): Unsubscribe {
		const handler = (
			launch: string,
			token: string,
			creator: string,
			curveType: bigint,
			softCap: bigint,
			hardCap: bigint,
			totalTokens: bigint,
			param1: bigint,
			param2: bigint,
		) => {
			const raw: LaunchCreatedEventRaw = {
				launch, token, creator, curveType, softCap, hardCap, totalTokens, param1, param2,
			};
			cb(toLaunchCreatedEventView(raw, opts), raw);
		};
		this.contract.on('LaunchCreated', handler);
		return () => { this.contract.off('LaunchCreated', handler); };
	}

	onLaunchFeePaid(
		cb: (view: LaunchFeePaidEventView, raw: LaunchFeePaidEventRaw) => void,
		usdtDecimals = 18
	): Unsubscribe {
		const handler = (payer: string, amount: bigint) => {
			const raw: LaunchFeePaidEventRaw = { payer, amount };
			cb(toLaunchFeePaidEventView(raw, usdtDecimals), raw);
		};
		this.contract.on('LaunchFeePaid', handler);
		return () => { this.contract.off('LaunchFeePaid', handler); };
	}

	onCurveDefaultsUpdated(cb: (raw: CurveDefaultsUpdatedEventRaw) => void): Unsubscribe {
		const handler = () => { cb({}); };
		this.contract.on('CurveDefaultsUpdated', handler);
		return () => { this.contract.off('CurveDefaultsUpdated', handler); };
	}

	onPlatformWalletUpdated(cb: (raw: PlatformWalletUpdatedEventRaw) => void): Unsubscribe {
		const handler = (newWallet: string) => { cb({ newWallet }); };
		this.contract.on('PlatformWalletUpdated', handler);
		return () => { this.contract.off('PlatformWalletUpdated', handler); };
	}

	onDexRouterUpdated(cb: (raw: DexRouterUpdatedEventRaw) => void): Unsubscribe {
		const handler = (newRouter: string) => { cb({ newRouter }); };
		this.contract.on('DexRouterUpdated', handler);
		return () => { this.contract.off('DexRouterUpdated', handler); };
	}

	onAuthorizedRouterUpdated(cb: (raw: AuthorizedRouterUpdatedEventRaw) => void): Unsubscribe {
		const handler = (newRouter: string) => { cb({ newRouter }); };
		this.contract.on('AuthorizedRouterUpdated', handler);
		return () => { this.contract.off('AuthorizedRouterUpdated', handler); };
	}

	onAffiliateUpdated(cb: (raw: AffiliateUpdatedEventRaw) => void): Unsubscribe {
		const handler = (previous: string, current: string) => { cb({ previous, current }); };
		this.contract.on('AffiliateUpdated', handler);
		return () => { this.contract.off('AffiliateUpdated', handler); };
	}

	onGlobalPauseChanged(cb: (raw: GlobalPauseChangedEventRaw) => void): Unsubscribe {
		const handler = (paused: boolean) => { cb({ paused }); };
		this.contract.on('GlobalPauseChanged', handler);
		return () => { this.contract.off('GlobalPauseChanged', handler); };
	}

	onLaunchPaused(cb: (raw: LaunchPausedEventRaw) => void): Unsubscribe {
		const handler = (launch: string, paused: boolean) => { cb({ launch, paused }); };
		this.contract.on('LaunchPaused', handler);
		return () => { this.contract.off('LaunchPaused', handler); };
	}

	onLaunchesPaused(
		cb: (view: LaunchesPausedEventView, raw: LaunchesPausedEventRaw) => void
	): Unsubscribe {
		const handler = (fromIndex: bigint, toIndex: bigint, paused: boolean) => {
			const raw: LaunchesPausedEventRaw = { fromIndex, toIndex, paused };
			cb(toLaunchesPausedEventView(raw), raw);
		};
		this.contract.on('LaunchesPaused', handler);
		return () => { this.contract.off('LaunchesPaused', handler); };
	}

	// ── Internals ──────────────────────────────────────────

	private async _send(method: string, args: unknown[]): Promise<TxResult> {
		const fn = this.contract[method] as ethers.BaseContractMethod;
		const tx = (await fn(...args)) as ethers.TransactionResponse;
		const receipt = await tx.wait();
		return { tx, receipt };
	}

	private _createLaunchArgs(p: CreateLaunchRawInput): unknown[] {
		return [
			p.token,
			p.totalTokens,
			Number(p.curveType),
			p.softCap,
			p.hardCap,
			BigInt(p.durationDays),
			BigInt(p.maxBuyBps),
			BigInt(p.creatorAllocationBps),
			BigInt(p.vestingDays),
			BigInt(p.startTimestamp),
			BigInt(p.lockDurationAfterListing),
			p.minBuyUsdt,
		];
	}

	private _createLaunchCustomCurveArgs(p: CreateLaunchCustomCurveRawInput): unknown[] {
		return [
			p.token,
			p.totalTokens,
			Number(p.curveType),
			p.curveParam1,
			p.curveParam2,
			p.softCap,
			p.hardCap,
			BigInt(p.durationDays),
			BigInt(p.maxBuyBps),
			BigInt(p.creatorAllocationBps),
			BigInt(p.vestingDays),
			BigInt(p.startTimestamp),
			BigInt(p.lockDurationAfterListing),
			p.minBuyUsdt,
		];
	}

	private async _parseLaunchCreated(tx: ethers.TransactionResponse): Promise<LaunchCreationResult> {
		const receipt = await tx.wait();
		let launchAddress = ethers.ZeroAddress;
		for (const log of receipt?.logs || []) {
			try {
				const parsed = this.iface.parseLog({ topics: [...log.topics], data: log.data });
				if (parsed?.name === 'LaunchCreated') {
					launchAddress = parsed.args[0] as string;
					break;
				}
			} catch {}
		}
		return { tx, receipt, launchAddress };
	}
}

// ════════════════════════════════════════════════════════════════════════════
//  Raw input types for creation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Bigint-native input for `createLaunch`. Callers parse user strings through
 * `toCreateLaunchRaw` (from `./structure/launchpadFactory`) or craft bigints
 * directly.
 */
export interface CreateLaunchRawInput {
	token: string;
	totalTokens: bigint;
	curveType: number;
	softCap: bigint;
	hardCap: bigint;
	durationDays: number | bigint;
	maxBuyBps: number | bigint;
	creatorAllocationBps: number | bigint;
	vestingDays: number | bigint;
	startTimestamp: number | bigint;
	lockDurationAfterListing: number | bigint;
	minBuyUsdt: bigint;
}

export interface CreateLaunchCustomCurveRawInput extends CreateLaunchRawInput {
	curveParam1: bigint;
	curveParam2: bigint;
}
