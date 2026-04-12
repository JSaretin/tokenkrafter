import { ethers } from 'ethers';
import type { TokenInfo } from './structure';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const ERC20_ABI = [
	'function balanceOf(address owner) view returns (uint256)',
	'function allowance(address owner, address spender) view returns (uint256)',
	'function approve(address spender, uint256 amount) returns (bool)',
	'function decimals() view returns (uint8)',
	'function symbol() view returns (string)',
	'function name() view returns (string)',
	'function totalSupply() view returns (uint256)'
];

export const FACTORY_ABI = [
	// Token creation — CreateTokenParams now takes a `bases[]` array (base
	// tokens the token should pre-create V2 pairs for at init time). Fees
	// are USDT-only and NOT payable: caller must approve(usdt, factory, fee)
	// before calling.
	'function createToken(tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address[] bases) p, address referral) external returns (address)',
	'function ownerCreateToken(address creator, tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address[] bases) p, address referral) external returns (address)',

	// Events
	'event TokenCreated(address indexed creator, address indexed tokenAddress, uint8 tokenType, string name, string symbol, uint256 totalSupply, uint8 decimals)',

	// View functions
	'function getCreationFees(bool isTaxable, bool isMintable, bool isPartner, address launchpadFactory) external view returns (uint256 creationFeeUsdt, uint256 launchFeeUsdt)',
	'function getCreatedTokens(address creator) external view returns (address[])',
	'function tokenInfo(address token) external view returns (address creator, bool isMintable, bool isTaxable, bool isPartnership)',
	'function predictTokenAddress(address creator, bool isTaxable, bool isMintable, bool isPartner) external view returns (address)',
	'function totalTokensCreated() view returns (uint256)',
	'function getTokenByIndex(uint256 index) external view returns (address)',
	'function getTokens(uint256 offset, uint256 limit) external view returns (address[] tokens, uint256 total)',
	// Full token metadata in a single paginated call — drop-in for explore-page reads
	'function getTokensInfo(uint256 offset, uint256 limit) external view returns (tuple(address tokenAddress, string name, string symbol, uint8 decimals, uint256 totalSupply, address creator, bool isMintable, bool isTaxable, bool isPartnership)[] views, uint256 total)',
	'function getState() external view returns (address factoryOwner, uint256 totalTokens, uint256 totalFeeUsdt, uint256[8] feesPerType, uint256[8] countPerType, bool taxToStable, uint256 taxSlippage, uint8 refLevels, bool autoDistribute)',
	'function creatorNonce(address) view returns (uint256)',
	'function totalFeeEarnedUsdt() view returns (uint256)',

	// Partner default bases (force-merged into bases[] for partner variants)
	'function getDefaultPartnerBases() external view returns (address[])',
	'function isDefaultPartnerBase(address) view returns (bool)',
	'function MAX_DEFAULT_PARTNER_BASES() view returns (uint256)',
	'function addDefaultPartnerBase(address base) external',
	'function removeDefaultPartnerBase(address base) external',
	'function setDefaultPartnerBases(address[] bases) external',

	// Tax processing
	'function convertTaxToStable() view returns (bool)',
	'function setConvertTaxToStable(bool enabled) external',
	'function processTax(address token) external',

	// Referral / Affiliate — USDT-only after refactor (single-dimension mappings)
	'function referrals(address) view returns (address)',
	'function referralLevels() view returns (uint8)',
	'function autoDistributeReward() view returns (bool)',
	'function referralPercents(uint256) view returns (uint256)',
	'function totalReferred(address) view returns (uint256)',
	'function totalEarned(address) view returns (uint256)',
	'function pendingRewards(address) view returns (uint256)',
	'function totalPendingRewards() view returns (uint256)',
	'function getReferralStats(address referrer) external view returns (uint256 referred, uint256 earned, uint256 pending)',
	'function getReferralChain(address user) external view returns (address[])',
	'function getReferralPercents() external view returns (uint256[])',
	'function claimReward() external',

	// Admin - Referral
	'function setReferralLevels(uint8 levels) external',
	'function setReferralPercents(uint256[] percents) external',
	'function setAutoDistributeReward(bool enabled) external',

	// Admin - Factory management
	'function owner() view returns (address)',
	'function setImplementation(uint8 tokenType, address impl) external',
	'function implementations(uint8) view returns (address)',
	'function setCreationFee(uint8 tokenType, uint256 fee) external',
	'function setImplementationsAndFees(address[8] impls, uint256[8] fees) external',
	'function creationFee(uint8) view returns (uint256)',
	'function setDexRouter(address _dexRouter) external',
	'function dexRouter() view returns (address)',
	'function usdt() view returns (address)',
	'function withdrawFees(address token) external',

	// Admin - Protection overrides
	'function forceUnblacklist(address token, address account) external',
	'function forceRelaxMaxWallet(address token, uint256 amount) external',
	'function forceRelaxMaxTransaction(address token, uint256 amount) external',
	'function forceRelaxCooldown(address token, uint256 seconds_) external',
	'function forceDisableBlacklist(address token) external',
	'function forceRelaxTaxes(address token, uint256 newBuyBps, uint256 newSellBps, uint256 newTransferBps) external'
];

// FeePayment struct shape:
//   tuple(address[] path, uint256 maxAmountIn)
// Rules (enforced in PlatformRouter._payFee):
//   - path[length-1] MUST equal usdt
//   - path == [usdt] (length 1) → direct USDT transferFrom, maxAmountIn ignored
//   - path[0] == address(0)    → native input, msg.value swapped entirely to USDT
//   - otherwise                → ERC20 input, maxAmountIn transferFrom then swap
// Surplus USDT from the swap is refunded to the caller *in USDT*, not the input token.
export const PLATFORM_ROUTER_ABI = [
	// Create token + bonding curve launch. FeePayment replaces the old
	// paymentToken field. LaunchParams dropped launchPaymentToken.
	'function createTokenAndLaunch(tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address[] bases) p, tuple(uint256 tokensForLaunch, uint8 curveType, uint256 softCap, uint256 hardCap, uint256 durationDays, uint256 maxBuyBps, uint256 creatorAllocationBps, uint256 vestingDays, uint256 startTimestamp, uint256 lockDurationAfterListing, uint256 minBuyUsdt) launch, tuple(uint256 maxWalletAmount, uint256 maxTransactionAmount, uint256 cooldownSeconds) protection, tuple(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, address[] taxWallets, uint16[] taxSharesBps) tax, tuple(address[] path, uint256 maxAmountIn) fee, address referral) external payable returns (address tokenAddress, address launchAddress)',

	// Create token + seed liquidity. When paying fees in native (BNB) AND
	// listing with a native LP pair, the router uses an exact-output swap
	// for the fee — only the BNB needed for the USDT fee is consumed, the
	// rest stays in the contract for LP wrapping. User sends total
	// msg.value = fee BNB + LP BNB in one transaction.
	'function createAndList(tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address[] bases) p, tuple(address[] bases, uint256[] baseAmounts, uint256[] tokenAmounts, bool burnLP, uint256 tradingDelay) list, tuple(uint256 maxWalletAmount, uint256 maxTransactionAmount, uint256 cooldownSeconds) protection, tuple(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, address[] taxWallets, uint16[] taxSharesBps) tax, tuple(address[] path, uint256 maxAmountIn) fee, address referral) external payable returns (address tokenAddress)',

	// Create token only (no listing, no launch).
	'function createTokenOnly(tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address[] bases) p, tuple(uint256 maxWalletAmount, uint256 maxTransactionAmount, uint256 cooldownSeconds) protection, tuple(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, address[] taxWallets, uint16[] taxSharesBps) tax, tuple(address[] path, uint256 maxAmountIn) fee, address referral) external payable returns (address tokenAddress)',

	// Launch an already-created platform token. Caller must transferOwnership(router)
	// BEFORE calling. `isTaxable` should match the token's actual variant so the
	// router knows to run tax exemptions.
	'function launchCreatedToken(address tokenAddress, tuple(uint256 tokensForLaunch, uint8 curveType, uint256 softCap, uint256 hardCap, uint256 durationDays, uint256 maxBuyBps, uint256 creatorAllocationBps, uint256 vestingDays, uint256 startTimestamp, uint256 lockDurationAfterListing, uint256 minBuyUsdt) launch, tuple(uint256 maxWalletAmount, uint256 maxTransactionAmount, uint256 cooldownSeconds) protection, tuple(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, address[] taxWallets, uint16[] taxSharesBps) tax, bool isTaxable, tuple(address[] path, uint256 maxAmountIn) fee) external payable returns (address launchAddress)',

	// Add liquidity to existing token.
	'function addLiquidityToExisting(address tokenAddress, tuple(address[] bases, uint256[] baseAmounts, uint256[] tokenAmounts, bool burnLP, uint256 tradingDelay) list) external payable',

	// Views
	'function usdt() view returns (address)',
	'function tokenFactory() view returns (address)',
	'function launchpadFactory() view returns (address)',
	'function dexRouter() view returns (address)',
	// Fee quoting — single call returns both the USDT fee and the input
	// token amount needed. typeKey = partner|taxable|mintable bitfield.
	// path follows the same FeePayment rules ([usdt] direct, [address(0), usdt] native, [erc20, ..., usdt] swap).
	'function quoteFee(uint8 typeKey, bool withLaunch, address[] path) view returns (uint256 usdtFee, uint256 amountIn)',

	// Events
	'event TokenCreatedAndLaunched(address indexed creator, address indexed token, address indexed launch)',
	'event TokenLaunched(address indexed creator, address indexed token, address indexed launch)',
	'event TokenCreatedAndListed(address indexed creator, address indexed token, uint256 poolCount, bool lpBurned)',
	'event TokenCreated(address indexed creator, address indexed token)',
	'event TokenListed(address indexed owner, address indexed token, uint256 poolCount, bool lpBurned)',
	'event LiquidityBurned(address indexed token, address indexed pair, uint256 lpAmount)'
];

export const TOKEN_ABI = [
	'function name() view returns (string)',
	'function symbol() view returns (string)',
	'function decimals() view returns (uint8)',
	'function totalSupply() view returns (uint256)',
	'function balanceOf(address) view returns (uint256)',
	'function owner() view returns (address)',
	'function mint(address to, uint256 amount) external',
	'function burn(uint256 amount) external',
	// Tax (only present on taxable variants — calls revert otherwise)
	'function buyTaxBps() view returns (uint256)',
	'function sellTaxBps() view returns (uint256)',
	'function transferTaxBps() view returns (uint256)',
	'function setTaxes(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps) external',
	'function setTaxDistribution(address[] wallets, uint16[] sharesBps) external',
	'function excludeFromTax(address account, bool exempt) external',
	'function taxWallets(uint256) view returns (address)',
	'function taxSharesBps(uint256) view returns (uint16)',
	'function isTaxFree(address) view returns (bool)',
	'event TaxesUpdated(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps)',
	// Tax ceiling — locks at launch/listing, unlocks on launch failure
	'function taxCeilingBuy() view returns (uint256)',
	'function taxCeilingSell() view returns (uint256)',
	'function taxCeilingTransfer() view returns (uint256)',
	'function MAX_BUY_TAX_BPS() view returns (uint256)',
	'function MAX_SELL_TAX_BPS() view returns (uint256)',
	'function MAX_TRANSFER_TAX_BPS() view returns (uint256)',
	'function lockTaxCeiling() external',
	'function unlockTaxCeiling() external',
	'event TaxCeilingLocked(uint256 buyCeiling, uint256 sellCeiling, uint256 transferCeiling)',
	'event TaxCeilingUnlocked()',
	// Pool registry — replaces the old isPool/addPool/removePool/setupPools surface
	'function pools(address) view returns (bool isPool)',
	'function dexFactory() view returns (address)',
	'function getPoolForBase(address base) view returns (address pair, bool registered)',
	'function addPool(address base) external',
	'function addPoolByAddress(address pool) external',
	// ERC20 surface
	'function approve(address spender, uint256 amount) returns (bool)',
	'function allowance(address owner, address spender) view returns (uint256)',
	// Trading control — tradingEnabled boolean is gone; we now have a sentinel
	// uint256 (type(uint256).max == not yet enabled). Use secondsUntilTradingOpens()
	// to render UI: 0 = open now, max = not yet scheduled, anything else = countdown.
	'function tradingStartTime() view returns (uint256)',
	'function tradingEnabledAt() view returns (uint256)',
	'function secondsUntilTradingOpens() view returns (uint256)',
	'function enableTrading(uint256 delay) external',
	'function MAX_TRADING_DELAY() view returns (uint256)',
	// Authorized launcher (for LaunchInstance to call enableTrading on graduation)
	'function isAuthorizedLauncher(address) view returns (bool)',
	'function setAuthorizedLauncher(address launcher, bool authorized) external',
	// Classic protection knobs
	'function maxWalletAmount() view returns (uint256)',
	'function maxTransactionAmount() view returns (uint256)',
	'function cooldownTime() view returns (uint256)',
	'function blacklistWindow() view returns (uint256)',
	'function blacklisted(address) view returns (bool)',
	'function isExcludedFromLimits(address) view returns (bool)',
	'function setMaxWalletAmount(uint256 amount) external',
	'function setMaxTransactionAmount(uint256 amount) external',
	'function setCooldownTime(uint256 seconds_) external',
	'function setBlacklistWindow(uint256 seconds_) external',
	'function setBlacklisted(address account, bool blocked) external',
	'function setExcludedFromLimits(address account, bool excluded) external',
	'event PoolRegistered(address indexed pool, address indexed base)',
	'event TradingEnabled(uint256 startsAt)',
	// Withdraw stuck tokens
	'function withdrawToken(address token) external'
];

export const ROUTER_ABI = [
	'function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256, uint256, uint256)',
	'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256, uint256, uint256)',
	'function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) returns (uint256, uint256)',
	'function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256, uint256)',
	'function factory() view returns (address)',
	'function WETH() view returns (address)'
];

export const FACTORY_V2_ABI = [
	'function getPair(address tokenA, address tokenB) view returns (address)',
	'function createPair(address tokenA, address tokenB) returns (address)'
];

export const PAIR_ABI = [
	'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
	'function token0() view returns (address)',
	'function token1() view returns (address)',
	'function totalSupply() view returns (uint256)'
];

export class ERC20Contract {
	contract: ethers.Contract;
	decimals_: number | null = null;

	constructor(address: string, signerOrProvider: ethers.ContractRunner) {
		this.contract = new ethers.Contract(address, ERC20_ABI, signerOrProvider);
	}

	async getDecimals(): Promise<number> {
		if (this.decimals_ !== null) return this.decimals_;
		this.decimals_ = Number(await this.contract.decimals());
		return this.decimals_;
	}

	async getBalance(owner: string): Promise<bigint> {
		return await this.contract.balanceOf(owner);
	}

	async getFormattedBalance(owner: string): Promise<string> {
		const bal = await this.contract.balanceOf(owner);
		const dec = await this.getDecimals();
		return ethers.formatUnits(bal, dec);
	}

	async allowance(owner: string, spender: string): Promise<bigint> {
		return await this.contract.allowance(owner, spender);
	}

	async approve(spender: string, amount: bigint) {
		const tx = await this.contract.approve(spender, amount);
		return await tx.wait();
	}
}

export class TokenFactory {
	contract: ethers.Contract;
	provider: ethers.Provider;

	constructor(address: string, signerOrProvider: ethers.ContractRunner) {
		this.provider = 'provider' in signerOrProvider
			? (signerOrProvider as any).provider
			: signerOrProvider as ethers.Provider;
		this.contract = new ethers.Contract(address, FACTORY_ABI, signerOrProvider);
	}

	async getCreationFee(isTaxable: boolean, isMintable: boolean, isPartner: boolean, launchpadAddress?: string): Promise<{ creationFeeUsdt: bigint; launchFeeUsdt: bigint }> {
		const [creationFeeUsdt, launchFeeUsdt] = await this.contract.getCreationFees(
			isTaxable, isMintable, isPartner,
			launchpadAddress || '0x0000000000000000000000000000000000000000'
		);
		return { creationFeeUsdt, launchFeeUsdt };
	}

	async getCreatedTokens(creator: string): Promise<string[]> {
		return await this.contract.getCreatedTokens(creator);
	}

	async getTokenInfo(token: string): Promise<{ creator: string; isMintable: boolean; isTaxable: boolean; isPartnership: boolean }> {
		const [creator, isMintable, isTaxable, isPartnership] = await this.contract.tokenInfo(token);
		return { creator, isMintable, isTaxable, isPartnership };
	}

	async getStats(): Promise<{ total: bigint }> {
		const total = await this.contract.totalTokensCreated();
		return { total };
	}

	async predictTokenAddress(creator: string, isTaxable: boolean, isMintable: boolean, isPartner: boolean): Promise<string> {
		return await this.contract.predictTokenAddress(creator, isTaxable, isMintable, isPartner);
	}

	async createToken(params: {
		name: string;
		symbol: string;
		totalSupply: bigint;
		decimals: number;
		isTaxable: boolean;
		isMintable: boolean;
		isPartner: boolean;
		bases: string[];
	}, referral: string = ZERO_ADDRESS) {
		const tx = await this.contract.createToken(params, referral);
		return await tx.wait();
	}

	// Referral / Affiliate — USDT-only after refactor

	async getReferralStats(referrer: string): Promise<{ referred: bigint; earned: bigint; pending: bigint }> {
		const [referred, earned, pending] = await this.contract.getReferralStats(referrer);
		return { referred, earned, pending };
	}

	async getReferralChain(user: string): Promise<string[]> {
		return await this.contract.getReferralChain(user);
	}

	async getReferralPercents(): Promise<bigint[]> {
		return await this.contract.getReferralPercents();
	}

	async getReferrer(user: string): Promise<string> {
		return await this.contract.referrals(user);
	}

	async claimReward() {
		const tx = await this.contract.claimReward();
		return await tx.wait();
	}

	async getPendingReward(user: string): Promise<bigint> {
		return await this.contract.pendingRewards(user);
	}

	async getAutoDistributeReward(): Promise<boolean> {
		return await this.contract.autoDistributeReward();
	}

	async getReferralLevels(): Promise<number> {
		return Number(await this.contract.referralLevels());
	}
}
