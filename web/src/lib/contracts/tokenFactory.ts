import { ethers } from 'ethers';
import { ERC20_ABI } from '../tokenCrafter';
import {
	TokenType,
	computeTypeKey as computeTypeKeyStruct,
	toCreateTokenParamsRaw,
	toTokenCreatedEventView,
	toImplementationUpdatedEventView,
	toFactoryStateView,
	toDayStatsView,
	toTokensPageView,
	toTokensInfoPageView,
	toTokenViewView,
	toTokenInfoView,
	toReferralStatsView,
	toCreationFeesView,
} from '../structure/tokenFactory';
import type {
	CreateTokenParamsInput,
	CreateTokenParamsRaw,
	TokenInfoRaw,
	TokenInfoView,
	TokenViewRaw,
	TokenViewView,
	DayStatsRaw,
	DayStatsView,
	FactoryStateRaw,
	FactoryStateView,
	ReferralStatsRaw,
	ReferralStatsView,
	CreationFeesRaw,
	CreationFeesView,
	TokensPageRaw,
	TokensPageView,
	TokensInfoPageRaw,
	TokensInfoPageView,
	TokenCreatedEventRaw,
	TokenCreatedEventView,
	ImplementationUpdatedEventRaw,
	ImplementationUpdatedEventView,
} from '../structure/tokenFactory';

/**
 * TODO: extract this ABI into `./tokenFactory.ts` as `TOKEN_FACTORY_ABI` to
 * mirror the `TRADE_ROUTER_ABI` pattern. Today the closest existing declaration
 * is `FACTORY_ABI` in `./tokenCrafter.ts`, but it carries an out-of-date
 * `TokenCreated` event signature (missing `fee` + `referrer`), so we declare
 * the full surface we care about locally.
 */
const TOKEN_FACTORY_ABI = [
	// ── Token creation ────────────────────────────────────────
	'function createToken(tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address[] bases) p, address referral) external returns (address)',
	'function ownerCreateToken(address creator, tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address[] bases) p, address referral) external returns (address)',
	'function routerCreateToken(address creator, tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address[] bases) p, address referral) external returns (address)',

	// ── Views ─────────────────────────────────────────────────
	'function usdt() view returns (address)',
	'function dexRouter() view returns (address)',
	'function authorizedRouter() view returns (address)',
	'function platformWallet() view returns (address)',
	'function affiliate() view returns (address)',
	'function owner() view returns (address)',
	'function creationFee(uint8) view returns (uint256)',
	'function implementations(uint8) view returns (address)',
	'function tokenInfo(address token) view returns (address creator, bool isMintable, bool isTaxable, bool isPartnership)',
	'function totalTokensCreated() view returns (uint256)',
	'function totalFeeEarnedUsdt() view returns (uint256)',
	'function tokensCreatedByType(uint8) view returns (uint256)',
	'function creatorNonce(address) view returns (uint256)',
	'function convertTaxToStable() view returns (bool)',
	'function taxSlippageBps() view returns (uint256)',
	'function dailyStats(uint256) view returns (uint256 basic, uint256 mintable, uint256 taxable, uint256 taxMintable, uint256 partner, uint256 partnerMint, uint256 partnerTax, uint256 partnerTaxMint, uint256 totalTokens, uint256 totalFeeUsdt)',
	'function getCreatedTokens(address creator) view returns (address[])',
	'function getTokenByIndex(uint256 index) view returns (address)',
	'function getTokens(uint256 offset, uint256 limit) view returns (address[] tokens, uint256 total)',
	'function getTokensInfo(uint256 offset, uint256 limit) view returns (tuple(address tokenAddress, string name, string symbol, uint8 decimals, uint256 totalSupply, address creator, bool isMintable, bool isTaxable, bool isPartnership)[] views, uint256 total)',
	'function getState() view returns (address factoryOwner, uint256 totalTokens, uint256 totalFeeUsdt, uint256[8] feesPerType, uint256[8] countPerType, bool taxToStable, uint256 taxSlippage, uint8 refLevels, bool autoDistribute)',
	'function getCreationFees(bool isTaxable, bool isMintable, bool isPartner, address launchpadFactory) view returns (uint256 creationFeeUsdt, uint256 launchFeeUsdt)',
	'function predictTokenAddress(address creator, bool isTaxable, bool isMintable, bool isPartner) view returns (address)',
	'function getDefaultPartnerBases() view returns (address[])',
	'function isDefaultPartnerBase(address) view returns (bool)',

	// ── Referrals (read) ──────────────────────────────────────
	'function referrals(address) view returns (address)',
	'function referralLevels() view returns (uint8)',
	'function referralPercents(uint256) view returns (uint256)',
	'function totalReferred(address) view returns (uint256)',
	'function totalEarned(address) view returns (uint256)',
	'function pendingRewards(address) view returns (uint256)',
	'function totalPendingRewards() view returns (uint256)',
	'function getReferralStats(address referrer) view returns (uint256 referred, uint256 earned, uint256 pending)',
	'function getReferralChain(address user) view returns (address[])',
	'function getReferralPercents() view returns (uint256[])',

	// ── Writes — admin ────────────────────────────────────────
	'function setImplementation(uint8 tokenType, address impl) external',
	'function setCreationFee(uint8 tokenType, uint256 fee) external',
	'function setImplementationsAndFees(address[8] impls, uint256[8] fees) external',
	'function setPlatformWallet(address wallet) external',
	'function setUsdt(address _usdt) external',
	'function setDexRouter(address _dexRouter) external',
	'function setAuthorizedRouter(address _router) external',
	'function setAffiliate(address aff) external',
	'function setConvertTaxToStable(bool enabled) external',
	'function setTaxSlippage(uint256 bps) external',
	'function setReferralLevels(uint8 levels) external',
	'function setReferralPercents(uint256[] percents) external',
	'function setAutoDistributeReward(bool enabled) external',
	'function withdrawFees(address token) external',
	'function claimReward() external',
	'function processTax(address token) external',

	// ── Partner default bases (admin) ────────────────────────
	'function addDefaultPartnerBase(address base) external',
	'function removeDefaultPartnerBase(address base) external',
	'function setDefaultPartnerBases(address[] bases) external',

	// ── Protection overrides (admin) ─────────────────────────
	'function forceUnblacklist(address token, address account) external',
	'function forceRelaxMaxWallet(address token, uint256 amount) external',
	'function forceRelaxMaxTransaction(address token, uint256 amount) external',
	'function forceRelaxCooldown(address token, uint256 seconds_) external',
	'function forceDisableBlacklist(address token) external',
	'function forceRelaxTaxes(address token, uint256 newBuyBps, uint256 newSellBps, uint256 newTransferBps) external',

	// ── Events ────────────────────────────────────────────────
	'event TokenCreated(address indexed creator, address indexed tokenAddress, uint8 tokenType, string name, string symbol, uint256 totalSupply, uint8 decimals, uint256 fee, address referrer)',
	'event ImplementationUpdated(uint8 indexed tokenType, address impl)',
	'event TaxProcessed(address indexed token, uint256 amountIn, uint256 amountOut)',
	'event ConvertTaxToStableUpdated(bool enabled)',
	'event TaxProcessFailed(address indexed token, uint256 amount)',
	'event ReferralRecorded(address indexed creator, address indexed referrer)',
	'event ReferralRewardDistributed(address indexed referrer, uint256 amount, uint8 level)',
	'event ReferralRewardClaimed(address indexed user, uint256 amount)',
	'event PlatformWalletUpdated(address indexed oldWallet, address indexed newWallet)',
	'event AffiliateUpdated(address indexed previous, address indexed current)',
	'event DefaultPartnerBaseAdded(address indexed base)',
	'event DefaultPartnerBaseRemoved(address indexed base)',
] as const;

// ════════════════════════════════════════════════════════════════════════════
//  Result shapes — parsed write-tx envelopes
// ════════════════════════════════════════════════════════════════════════════

export interface CreateTokenResult {
	tx: ethers.TransactionResponse;
	receipt: ethers.TransactionReceipt | null;
	/** Address of the newly cloned token, extracted from `TokenCreated`. */
	tokenAddress: string;
	/** Type key (0..7) recorded by the factory. */
	tokenType: number;
	/** Raw USDT fee paid (decimals = USDT). */
	fee: bigint;
	/** Parsed `TokenCreated` event with strings-for-display formatting. */
	event: TokenCreatedEventView | null;
}

export interface FeeByType {
	0: bigint;
	1: bigint;
	2: bigint;
	3: bigint;
	4: bigint;
	5: bigint;
	6: bigint;
	7: bigint;
}

/**
 * Typed wrapper around the TokenFactory smart contract.
 * Handles token creation (with USDT fee approval), per-creator enumeration,
 * per-type fee/impl lookups, event parsing, and admin operations.
 */
export class TokenFactoryClient {
	readonly contract: ethers.Contract;
	private readonly iface = new ethers.Interface(TOKEN_FACTORY_ABI);

	constructor(address: string, signerOrProvider: ethers.Signer | ethers.Provider) {
		this.contract = new ethers.Contract(address, TOKEN_FACTORY_ABI, signerOrProvider);
	}

	/** Create a new instance connected to a signer (for write operations). */
	connect(signer: ethers.Signer): TokenFactoryClient {
		return new TokenFactoryClient(this.contract.target as string, signer);
	}

	// ── Simple view getters ─────────────────────────────────

	async platformWallet(): Promise<string> { return this.contract.platformWallet(); }
	async usdt(): Promise<string> { return this.contract.usdt(); }
	async dexRouter(): Promise<string> { return this.contract.dexRouter(); }
	async authorizedRouter(): Promise<string> { return this.contract.authorizedRouter(); }
	async affiliate(): Promise<string> { return this.contract.affiliate(); }
	async owner(): Promise<string> { return this.contract.owner(); }
	async totalTokensCreated(): Promise<number> { return Number(await this.contract.totalTokensCreated()); }
	async totalFeeEarnedUsdt(): Promise<bigint> { return BigInt(await this.contract.totalFeeEarnedUsdt()); }

	/** Creation fee in USDT (raw, USDT decimals) for the given type key 0..7. */
	async creationFee(typeKey: number): Promise<bigint> {
		this._assertTypeKey(typeKey);
		return BigInt(await this.contract.creationFee(typeKey));
	}

	/** Implementation clone-master for a given type key 0..7. */
	async implementations(typeKey: number): Promise<string> {
		this._assertTypeKey(typeKey);
		return this.contract.implementations(typeKey);
	}

	/** Fetches all 8 creation fees in a single Promise.all. */
	async getAllCreationFees(): Promise<FeeByType> {
		const fees = await Promise.all(
			[0, 1, 2, 3, 4, 5, 6, 7].map(k => this.contract.creationFee(k).then((v: bigint) => BigInt(v))),
		);
		return {
			0: fees[0], 1: fees[1], 2: fees[2], 3: fees[3],
			4: fees[4], 5: fees[5], 6: fees[6], 7: fees[7],
		};
	}

	/** Fetches all 8 implementation addresses in a single Promise.all. */
	async getAllImplementations(): Promise<Record<number, string>> {
		const impls = await Promise.all(
			[0, 1, 2, 3, 4, 5, 6, 7].map(k => this.contract.implementations(k)),
		);
		return Object.fromEntries(impls.map((a, i) => [i, a as string]));
	}

	/**
	 * USDT creation fee + optional launch fee, via the contract's view helper.
	 * `launchpadFactory` may be the zero address to skip the launch-fee lookup.
	 */
	async getCreationFees(
		isTaxable: boolean,
		isMintable: boolean,
		isPartner: boolean,
		launchpadFactory: string = ethers.ZeroAddress,
	): Promise<CreationFeesRaw> {
		const [creationFeeUsdt, launchFeeUsdt] = await this.contract.getCreationFees(
			isTaxable, isMintable, isPartner, launchpadFactory,
		);
		return { creationFeeUsdt: BigInt(creationFeeUsdt), launchFeeUsdt: BigInt(launchFeeUsdt) };
	}

	async getCreationFeesView(
		isTaxable: boolean,
		isMintable: boolean,
		isPartner: boolean,
		launchpadFactory: string = ethers.ZeroAddress,
		usdtDecimals = 18,
	): Promise<CreationFeesView> {
		return toCreationFeesView(
			await this.getCreationFees(isTaxable, isMintable, isPartner, launchpadFactory),
			usdtDecimals,
		);
	}

	/** Metadata for a given factory-created token. */
	async tokenInfo(token: string): Promise<TokenInfoRaw> {
		const [creator, isMintable, isTaxable, isPartnership] = await this.contract.tokenInfo(token);
		return { creator, isMintable, isTaxable, isPartnership };
	}

	async tokenInfoView(token: string): Promise<TokenInfoView> {
		return toTokenInfoView(await this.tokenInfo(token));
	}

	/** Per-creator token list (contract returns the full array in one call). */
	async getCreatorTokens(creator: string): Promise<string[]> {
		return this.contract.getCreatedTokens(creator);
	}

	/**
	 * Walks the global token registry by index until a revert. This is a
	 * defensive fallback for clients that can't rely on `getTokens(offset,
	 * limit)` (e.g. estimated-size paging); prefer `getTokensPage` when
	 * possible — it returns `total` in the same call.
	 */
	async walkTokensByIndex(start = 0, max = 10_000): Promise<string[]> {
		const out: string[] = [];
		for (let i = start; i < start + max; i++) {
			try {
				const addr: string = await this.contract.getTokenByIndex(i);
				if (!addr || addr === ethers.ZeroAddress) break;
				out.push(addr);
			} catch {
				break;
			}
		}
		return out;
	}

	/** Paginated token list — `(addresses[], total)`. */
	async getTokensPage(offset: number, limit: number): Promise<TokensPageRaw> {
		const [tokens, total] = await this.contract.getTokens(offset, limit);
		return { tokens: [...tokens] as string[], total: BigInt(total) };
	}

	async getTokensPageView(offset: number, limit: number): Promise<TokensPageView> {
		return toTokensPageView(await this.getTokensPage(offset, limit));
	}

	/** Paginated token list with full metadata — one RPC call. */
	async getTokensInfo(offset: number, limit: number): Promise<TokensInfoPageRaw> {
		const [views, total] = await this.contract.getTokensInfo(offset, limit);
		const normalizedViews: TokenViewRaw[] = (views as TokenViewRaw[]).map(v => ({
			tokenAddress: v.tokenAddress,
			name: v.name,
			symbol: v.symbol,
			decimals: Number(v.decimals),
			totalSupply: BigInt(v.totalSupply),
			creator: v.creator,
			isMintable: v.isMintable,
			isTaxable: v.isTaxable,
			isPartnership: v.isPartnership,
		}));
		return { views: normalizedViews, total: BigInt(total) };
	}

	async getTokensInfoView(offset: number, limit: number): Promise<TokensInfoPageView> {
		return toTokensInfoPageView(await this.getTokensInfo(offset, limit));
	}

	/** One-shot view of key factory state (owner, totals, fees, counts, flags). */
	async getState(): Promise<FactoryStateRaw> {
		const [
			factoryOwner, totalTokens, totalFeeUsdt, feesPerType, countPerType,
			taxToStable, taxSlippage, refLevels, autoDistribute,
		] = await this.contract.getState();
		return {
			factoryOwner,
			totalTokens: BigInt(totalTokens),
			totalFeeUsdt: BigInt(totalFeeUsdt),
			feesPerType: (feesPerType as readonly bigint[]).map(f => BigInt(f)),
			countPerType: (countPerType as readonly bigint[]).map(c => BigInt(c)),
			taxToStable,
			taxSlippage: BigInt(taxSlippage),
			refLevels: Number(refLevels),
			autoDistribute,
		};
	}

	async getStateView(usdtDecimals = 18): Promise<FactoryStateView> {
		return toFactoryStateView(await this.getState(), usdtDecimals);
	}

	/** Daily stats snapshot for `dayIndex` = floor(unixSeconds / 86400). */
	async dailyStats(dayIndex: number): Promise<DayStatsRaw> {
		const r = await this.contract.dailyStats(dayIndex);
		return {
			basic: BigInt(r[0]),
			mintable: BigInt(r[1]),
			taxable: BigInt(r[2]),
			taxMintable: BigInt(r[3]),
			partner: BigInt(r[4]),
			partnerMint: BigInt(r[5]),
			partnerTax: BigInt(r[6]),
			partnerTaxMint: BigInt(r[7]),
			totalTokens: BigInt(r[8]),
			totalFeeUsdt: BigInt(r[9]),
		};
	}

	async dailyStatsView(dayIndex: number, usdtDecimals = 18): Promise<DayStatsView> {
		return toDayStatsView(await this.dailyStats(dayIndex), usdtDecimals);
	}

	/** Same as contract view; unwraps bigints for convenience. */
	async getReferralStats(referrer: string): Promise<ReferralStatsRaw> {
		const [referred, earned, pending] = await this.contract.getReferralStats(referrer);
		return { referred: BigInt(referred), earned: BigInt(earned), pending: BigInt(pending) };
	}

	async getReferralStatsView(referrer: string, usdtDecimals = 18): Promise<ReferralStatsView> {
		return toReferralStatsView(await this.getReferralStats(referrer), usdtDecimals);
	}

	async predictTokenAddress(
		creator: string,
		isTaxable: boolean,
		isMintable: boolean,
		isPartner: boolean,
	): Promise<string> {
		return this.contract.predictTokenAddress(creator, isTaxable, isMintable, isPartner);
	}

	async getDefaultPartnerBases(): Promise<string[]> {
		return this.contract.getDefaultPartnerBases();
	}

	// ── Writes: token creation ──────────────────────────────

	/**
	 * Low-level create. Caller must have already approved the factory for the
	 * USDT creation fee. Use `createTokenAndPay` to automate approval.
	 */
	async createToken(
		params: CreateTokenParamsInput | CreateTokenParamsRaw,
		referrer: string = ethers.ZeroAddress,
	): Promise<CreateTokenResult> {
		const raw = this._toParamsRaw(params);
		const est = await this.contract.createToken.estimateGas(raw, referrer);
		const tx = await this.contract.createToken(raw, referrer, { gasLimit: est * 130n / 100n });
		return this._parseCreateReceipt(tx);
	}

	/**
	 * Owner-only. Creates a token on behalf of `creator`. Owner pays the USDT fee.
	 */
	async ownerCreateToken(
		creator: string,
		params: CreateTokenParamsInput | CreateTokenParamsRaw,
		referrer: string = ethers.ZeroAddress,
	): Promise<CreateTokenResult> {
		const raw = this._toParamsRaw(params);
		const est = await this.contract.ownerCreateToken.estimateGas(creator, raw, referrer);
		const tx = await this.contract.ownerCreateToken(creator, raw, referrer, { gasLimit: est * 130n / 100n });
		return this._parseCreateReceipt(tx);
	}

	/**
	 * Creates a token and handles the USDT fee approval automatically. Looks
	 * up the per-type creation fee, approves the factory for that amount
	 * (topping up if existing allowance is insufficient), then calls
	 * `createToken`. Requires a signer.
	 */
	async createTokenAndPay(
		params: CreateTokenParamsInput | CreateTokenParamsRaw,
		referrer: string = ethers.ZeroAddress,
	): Promise<CreateTokenResult> {
		const raw = this._toParamsRaw(params);
		const typeKey = TokenFactoryClient.computeTypeKey(raw.isMintable, raw.isTaxable, raw.isPartner);

		const [usdtAddr, fee] = await Promise.all([
			this.usdt(),
			this.creationFee(typeKey),
		]);

		const runner = this.contract.runner;
		if (!runner || !('sendTransaction' in runner)) {
			throw new Error('createTokenAndPay requires a signer');
		}
		const signer = runner as ethers.Signer;
		const signerAddr = await signer.getAddress();

		if (fee > 0n) {
			const usdt = new ethers.Contract(usdtAddr, ERC20_ABI, signer);
			const factoryAddr = this.contract.target as string;
			const current: bigint = await usdt.allowance(signerAddr, factoryAddr);
			if (current < fee) {
				const approveTx = await usdt.approve(factoryAddr, fee);
				await approveTx.wait();
			}
		}

		return this.createToken(raw, referrer);
	}

	// ── Writes: admin ───────────────────────────────────────

	async setImplementation(typeKey: number, impl: string): Promise<ethers.TransactionReceipt | null> {
		this._assertTypeKey(typeKey);
		return (await this.contract.setImplementation(typeKey, impl)).wait();
	}

	async setCreationFee(typeKey: number, fee: bigint): Promise<ethers.TransactionReceipt | null> {
		this._assertTypeKey(typeKey);
		return (await this.contract.setCreationFee(typeKey, fee)).wait();
	}

	async setImplementationsAndFees(
		impls: [string, string, string, string, string, string, string, string],
		fees: [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
	): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.setImplementationsAndFees(impls, fees)).wait();
	}

	async setPlatformWallet(wallet: string): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.setPlatformWallet(wallet)).wait();
	}

	async setUsdt(usdt: string): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.setUsdt(usdt)).wait();
	}

	async setDexRouter(dexRouter: string): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.setDexRouter(dexRouter)).wait();
	}

	async setAuthorizedRouter(router: string): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.setAuthorizedRouter(router)).wait();
	}

	async setAffiliate(affiliate: string): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.setAffiliate(affiliate)).wait();
	}

	async withdrawFees(token: string): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.withdrawFees(token)).wait();
	}

	async setConvertTaxToStable(enabled: boolean): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.setConvertTaxToStable(enabled)).wait();
	}

	async setTaxSlippage(bps: number): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.setTaxSlippage(bps)).wait();
	}

	async processTax(token: string): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.processTax(token)).wait();
	}

	async claimReward(): Promise<ethers.TransactionReceipt | null> {
		return (await this.contract.claimReward()).wait();
	}

	// ── Events ──────────────────────────────────────────────

	/**
	 * Subscribe to `TokenCreated`. Callback receives the decoded view (enum
	 * type key, formatted supply / fee) — not the raw bigint tuple.
	 *
	 * Returns an unsubscribe fn.
	 */
	onTokenCreated(cb: (view: TokenCreatedEventView, rawLog: ethers.Log) => void, usdtDecimals = 18): () => void {
		const handler = (
			creator: string,
			tokenAddress: string,
			tokenType: bigint,
			name: string,
			symbol: string,
			totalSupply: bigint,
			decimals: bigint,
			fee: bigint,
			referrer: string,
			event: ethers.ContractEventPayload,
		) => {
			const raw: TokenCreatedEventRaw = {
				creator,
				tokenAddress,
				tokenType: Number(tokenType),
				name,
				symbol,
				totalSupply: BigInt(totalSupply),
				decimals: Number(decimals),
				fee: BigInt(fee),
				referrer,
			};
			cb(toTokenCreatedEventView(raw, usdtDecimals), event.log);
		};
		this.contract.on('TokenCreated', handler);
		return () => { this.contract.off('TokenCreated', handler); };
	}

	onImplementationUpdated(cb: (view: ImplementationUpdatedEventView, rawLog: ethers.Log) => void): () => void {
		const handler = (tokenType: bigint, impl: string, event: ethers.ContractEventPayload) => {
			const raw: ImplementationUpdatedEventRaw = { tokenType: Number(tokenType), impl };
			cb(toImplementationUpdatedEventView(raw), event.log);
		};
		this.contract.on('ImplementationUpdated', handler);
		return () => { this.contract.off('ImplementationUpdated', handler); };
	}

	/**
	 * The contract doesn't emit a dedicated `CreationFeeUpdated` event —
	 * `setCreationFee` silently mutates the mapping. The closest observable
	 * signal is `ImplementationUpdated` (fired from `setImplementationsAndFees`
	 * which batches both). We still expose this helper so callers can register
	 * intent; today it's an alias for `onImplementationUpdated`.
	 *
	 * TODO: if the contract gains a dedicated event, switch to listening for it.
	 */
	onCreationFeeUpdated(cb: (view: ImplementationUpdatedEventView, rawLog: ethers.Log) => void): () => void {
		return this.onImplementationUpdated(cb);
	}

	// ── Utilities ───────────────────────────────────────────

	/** Type-key bitfield: partner=4, taxable=2, mintable=1. */
	static computeTypeKey(isMintable: boolean, isTaxable: boolean, isPartner: boolean): number {
		return computeTypeKeyStruct({ isMintable, isTaxable, isPartner });
	}

	/** Inverse of `computeTypeKey`. */
	static decodeTypeKey(typeKey: number): { isMintable: boolean; isTaxable: boolean; isPartner: boolean } {
		return {
			isPartner: (typeKey & 4) !== 0,
			isTaxable: (typeKey & 2) !== 0,
			isMintable: (typeKey & 1) !== 0,
		};
	}

	// ── Internals ───────────────────────────────────────────

	private _assertTypeKey(typeKey: number): void {
		if (!Number.isInteger(typeKey) || typeKey < 0 || typeKey > 7) {
			throw new Error(`typeKey must be an integer in 0..7 (got ${typeKey})`);
		}
	}

	private _toParamsRaw(params: CreateTokenParamsInput | CreateTokenParamsRaw): CreateTokenParamsRaw {
		// CreateTokenParamsRaw has a bigint totalSupply; Input has a string.
		if (typeof (params as CreateTokenParamsRaw).totalSupply === 'bigint') {
			return params as CreateTokenParamsRaw;
		}
		return toCreateTokenParamsRaw(params as CreateTokenParamsInput);
	}

	private async _parseCreateReceipt(tx: ethers.TransactionResponse): Promise<CreateTokenResult> {
		const receipt = await tx.wait();
		let tokenAddress = ethers.ZeroAddress;
		let tokenType = 0;
		let fee = 0n;
		let event: TokenCreatedEventView | null = null;

		for (const log of receipt?.logs || []) {
			try {
				const parsed = this.iface.parseLog({ topics: [...log.topics], data: log.data });
				if (parsed?.name === 'TokenCreated') {
					const args = parsed.args;
					const raw: TokenCreatedEventRaw = {
						creator: args.creator,
						tokenAddress: args.tokenAddress,
						tokenType: Number(args.tokenType),
						name: args.name,
						symbol: args.symbol,
						totalSupply: BigInt(args.totalSupply),
						decimals: Number(args.decimals),
						fee: BigInt(args.fee),
						referrer: args.referrer,
					};
					tokenAddress = raw.tokenAddress;
					tokenType = raw.tokenType;
					fee = raw.fee;
					event = toTokenCreatedEventView(raw);
					break;
				}
			} catch { /* not our event */ }
		}

		return { tx, receipt, tokenAddress, tokenType, fee, event };
	}
}

// Re-export common enums so callers only need to import the client module.
export { TokenType };
