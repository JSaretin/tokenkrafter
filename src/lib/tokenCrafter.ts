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
	// Token creation
	'function createToken(tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address paymentToken) p, address referral) external payable returns (address)',
	'function ownerCreateToken(address creator, tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address paymentToken) p, address referral) external payable returns (address)',

	// Token creation + launch
	'function createTokenAndLaunch(tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address paymentToken) p, tuple(uint256 tokensForLaunch, uint8 curveType, uint256 softCap, uint256 hardCap, uint256 durationDays, uint256 maxBuyBps, uint256 creatorAllocationBps, uint256 vestingDays, address launchPaymentToken, uint256 startTimestamp) launch, tuple(uint256 maxWalletAmount, uint256 maxTransactionAmount, uint256 cooldownSeconds) protection, tuple(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, address[] taxWallets, uint16[] taxSharesBps) tax, address referral) external payable returns (address tokenAddress, address launchAddress)',

	// Events
	'event TokenCreatedAndLaunched(address indexed creator, address indexed token, address indexed launch)',

	// View functions
	'function convertFee(uint256 usdtAmount, address paymentToken) external view returns (uint256)',
	'function getCreationFees(bool isTaxable, bool isMintable, bool isPartner, address launchpadFactory) external view returns (address[] paymentTokens, uint256[] creationFees, uint256[] launchFees)',
	'function getCreatedTokens(address creator) external view returns (address[])',
	'function getSupportedPaymentTokens() external view returns (address[])',
	'function tokenInfo(address token) external view returns (address creator, bool isMintable, bool isTaxable, bool isPartnership)',
	'function predictTokenAddress(address creator, bool isTaxable, bool isMintable, bool isPartner) external view returns (address)',
	'function totalTokensCreated() view returns (uint256)',
	'function getTokenByIndex(uint256 index) external view returns (address)',
	'function getTokens(uint256 offset, uint256 limit) external view returns (address[] tokens, uint256 total)',
	'function getState() external view returns (address factoryOwner, uint256 totalTokens, uint256 totalFeeUsdt, uint256[8] feesPerType, uint256[8] countPerType, address[] paymentTokens, bool taxToStable, uint256 taxSlippage, uint8 refLevels, bool autoDistribute)',
	'function creatorNonce(address) view returns (uint256)',
	'function totalFeeEarnedUsdt() view returns (uint256)',
	'function getDailyStats(uint256 fromDay, uint256 toDay) view returns (tuple(uint256 basic, uint256 mintable, uint256 taxable, uint256 taxMintable, uint256 partner, uint256 partnerMint, uint256 partnerTax, uint256 partnerTaxMint, uint256 total, uint256 totalFeeUsdt)[])',

	// Tax processing
	'function convertTaxToStable() view returns (bool)',
	'function setConvertTaxToStable(bool enabled) external',
	'function processTax(address token) external',

	// Referral / Affiliate
	'function referrals(address) view returns (address)',
	'function referralLevels() view returns (uint8)',
	'function autoDistributeReward() view returns (bool)',
	'function referralPercents(uint256) view returns (uint256)',
	'function totalReferred(address) view returns (uint256)',
	'function totalEarned(address, address) view returns (uint256)',
	'function pendingRewards(address, address) view returns (uint256)',
	'function getReferralStats(address referrer, address[] paymentTokens) external view returns (uint256 referred, uint256[] earned, uint256[] pending)',
	'function getReferralChain(address user) external view returns (address[])',
	'function getReferralPercents() external view returns (uint256[])',
	'function claimReward(address paymentToken) external',

	// Admin - Referral
	'function setReferralLevels(uint8 levels) external',
	'function setReferralPercents(uint256[] percents) external',
	'function setAutoDistributeReward(bool enabled) external',

	// Admin - Factory management
	'function owner() view returns (address)',
	'function setImplementation(uint8 tokenType, address impl) external',
	'function implementations(uint8) view returns (address)',
	'function setCreationFee(uint8 tokenType, uint256 fee) external',
	'function creationFee(uint8) view returns (uint256)',
	'function setDexRouter(address _dexRouter) external',
	'function dexRouter() view returns (address)',
	'function usdt() view returns (address)',
	'function addPaymentToken(address token) external',
	'function removePaymentToken(address token) external',
	'function withdrawFees(address token) external',
	'function withdraw() external',
	'function withdraw(address to) external',
	'function withdraw(address to, uint256 amount) external',

	// Admin - Protection overrides
	'function forceUnblacklist(address token, address account) external',
	'function forceRelaxMaxWallet(address token, uint256 amount) external',
	'function forceRelaxMaxTransaction(address token, uint256 amount) external',
	'function forceRelaxCooldown(address token, uint256 seconds_) external',
	'function forceDisableBlacklist(address token) external'
];

export const PLATFORM_ROUTER_ABI = [
	// Create token + bonding curve launch
	'function createTokenAndLaunch(tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address paymentToken) p, tuple(uint256 tokensForLaunch, uint8 curveType, uint256 softCap, uint256 hardCap, uint256 durationDays, uint256 maxBuyBps, uint256 creatorAllocationBps, uint256 vestingDays, address launchPaymentToken, uint256 startTimestamp) launch, tuple(uint256 maxWalletAmount, uint256 maxTransactionAmount, uint256 cooldownSeconds) protection, tuple(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, address[] taxWallets, uint16[] taxSharesBps) tax, address referral) external payable returns (address tokenAddress, address launchAddress)',

	// Create token + add liquidity to DEX pools (with optional LP burn)
	'function createAndList(tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address paymentToken) p, tuple(address[] bases, uint256[] baseAmounts, uint256[] tokenAmounts, bool burnLP) list, tuple(uint256 maxWalletAmount, uint256 maxTransactionAmount, uint256 cooldownSeconds) protection, tuple(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, address[] taxWallets, uint16[] taxSharesBps) tax, address referral) external payable returns (address tokenAddress)',

	// Create token only (no listing, no launch)
	'function createTokenOnly(tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address paymentToken) p, tuple(uint256 maxWalletAmount, uint256 maxTransactionAmount, uint256 cooldownSeconds) protection, tuple(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, address[] taxWallets, uint16[] taxSharesBps) tax, address referral) external payable returns (address tokenAddress)',

	// Add liquidity to existing token (with optional LP burn + pool registration)
	'function addLiquidityToExisting(address tokenAddress, tuple(address[] bases, uint256[] baseAmounts, uint256[] tokenAmounts, bool burnLP) list) external payable',

	// Events
	'event TokenCreatedAndLaunched(address indexed creator, address indexed token, address indexed launch)',
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
	'function buyTaxBps() view returns (uint256)',
	'function sellTaxBps() view returns (uint256)',
	'function transferTaxBps() view returns (uint256)',
	'function setTaxes(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps) external',
	'function setTaxDistribution(address[] wallets, uint16[] sharesBps) external',
	'function excludeFromTax(address account, bool exempt) external',
	'function taxWallets(uint256) view returns (address)',
	'function taxSharesBps(uint256) view returns (uint16)',
	'function isTaxFree(address) view returns (bool)',
	'function isPool(address) view returns (bool)',
	'function addPool(address pool) external',
	'function removePool(address pool) external',
	'function poolFactory() view returns (address)',
	'function setupPools(address[] pools) external',
	'function approve(address spender, uint256 amount) returns (bool)',
	'function allowance(address owner, address spender) view returns (uint256)',
	// Protection features
	'function tradingEnabled() view returns (bool)',
	'function maxWalletAmount() view returns (uint256)',
	'function maxTransactionAmount() view returns (uint256)',
	'function cooldownTime() view returns (uint256)',
	'function blacklistWindow() view returns (uint256)',
	'function tradingEnabledAt() view returns (uint256)',
	'function blacklisted(address) view returns (bool)',
	'function isExcludedFromLimits(address) view returns (bool)',
	'function enableTrading() external',
	'function setMaxWalletAmount(uint256 amount) external',
	'function setMaxTransactionAmount(uint256 amount) external',
	'function setCooldownTime(uint256 seconds_) external',
	'function setBlacklistWindow(uint256 seconds_) external',
	'function setBlacklisted(address account, bool blocked) external',
	'function setExcludedFromLimits(address account, bool excluded) external',
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

	async getCreationFee(isTaxable: boolean, isMintable: boolean, isPartner: boolean, launchpadAddress?: string): Promise<{ tokens: string[]; fees: bigint[]; launchFees: bigint[] }> {
		const [tokens, fees, launchFees] = await this.contract.getCreationFees(
			isTaxable, isMintable, isPartner,
			launchpadAddress || '0x0000000000000000000000000000000000000000'
		);
		return { tokens: [...tokens], fees: [...fees], launchFees: [...launchFees] };
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
		paymentToken: string;
	}, referral: string = ZERO_ADDRESS, nativeValue?: bigint) {
		const tx = await this.contract.createToken(params, referral, nativeValue ? { value: nativeValue } : {});
		return await tx.wait();
	}

	// Referral / Affiliate

	async getReferralStats(referrer: string, paymentTokens: string[]): Promise<{ referred: bigint; earned: bigint[]; pending: bigint[] }> {
		const [referred, earned, pending] = await this.contract.getReferralStats(referrer, paymentTokens);
		return { referred, earned: [...earned], pending: [...pending] };
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

	async claimReward(paymentToken: string) {
		const tx = await this.contract.claimReward(paymentToken);
		return await tx.wait();
	}

	async getPendingReward(user: string, paymentToken: string): Promise<bigint> {
		return await this.contract.pendingRewards(user, paymentToken);
	}

	async getAutoDistributeReward(): Promise<boolean> {
		return await this.contract.autoDistributeReward();
	}

	async getReferralLevels(): Promise<number> {
		return Number(await this.contract.referralLevels());
	}
}
