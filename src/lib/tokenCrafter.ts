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

	// View functions
	'function getCreationFee(bool isTaxable, bool isMintable, bool isPartner) external view returns (address[] tokens, uint256[] fees)',
	'function getCreatedTokens(address creator) external view returns (address[])',
	'function getSupportedPaymentTokens() external view returns (address[])',
	'function getTokenInfo(address token) external view returns (tuple(address creator, bool isMintable, bool isTaxable, bool isPartnership))',
	'function getStats() external view returns (uint256 total, uint256[8] byType)',
	'function predictTokenAddress(address creator, bool isTaxable, bool isMintable, bool isPartner) external view returns (address)',
	'function totalTokensCreated() view returns (uint256)',
	'function creatorNonce(address) view returns (uint256)',

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
	'function withdrawToken(address token) external',

	// Admin - Protection overrides
	'function forceUnblacklist(address token, address account) external',
	'function forceRelaxMaxWallet(address token, uint256 amount) external',
	'function forceRelaxMaxTransaction(address token, uint256 amount) external',
	'function forceRelaxCooldown(address token, uint256 seconds_) external',
	'function forceDisableBlacklist(address token) external'
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

	async getCreationFee(isTaxable: boolean, isMintable: boolean, isPartner: boolean): Promise<{ tokens: string[]; fees: bigint[] }> {
		const [tokens, fees] = await this.contract.getCreationFee(isTaxable, isMintable, isPartner);
		return { tokens: [...tokens], fees: [...fees] };
	}

	async getCreatedTokens(creator: string): Promise<string[]> {
		return await this.contract.getCreatedTokens(creator);
	}

	async getTokenInfo(token: string): Promise<{ creator: string; isMintable: boolean; isTaxable: boolean; isPartnership: boolean }> {
		return await this.contract.getTokenInfo(token);
	}

	async getStats(): Promise<{ total: bigint; byType: bigint[] }> {
		const [total, byType] = await this.contract.getStats();
		return { total, byType: [...byType] };
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
