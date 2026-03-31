/**
 * Direct ethers.js helpers for contract setup/teardown in E2E tests.
 * These call the Hardhat node directly — no browser needed.
 */
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { HARDHAT_PRIVATE_KEY, RPC_URL } from '../fixtures/mock-provider';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEPLOYMENT_PATH = path.resolve(__dirname, '../../../solidty-contracts/deployments/localhost.json');

export interface Deployment {
	MockUSDT: string;
	MockRouter: string;
	BondingCurve: string;
	TokenFactory: string;
	LaunchpadFactory: string;
	PlatformRouter: string;
	[key: string]: string;
}

let _deployment: Deployment | null = null;

export function getDeployment(): Deployment {
	if (!_deployment) {
		_deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, 'utf8'));
	}
	return _deployment!;
}

export function getProvider() {
	return new ethers.JsonRpcProvider(RPC_URL);
}

export function getSigner() {
	const provider = getProvider();
	const wallet = new ethers.Wallet(HARDHAT_PRIVATE_KEY, provider);
	return new ethers.NonceManager(wallet);
}

// ── Snapshot / Revert for test isolation ──

export async function takeSnapshot(): Promise<string> {
	const provider = getProvider();
	return await provider.send('evm_snapshot', []);
}

export async function revertToSnapshot(snapshotId: string): Promise<void> {
	const provider = getProvider();
	await provider.send('evm_revert', [snapshotId]);
}

// ── USDT helpers ──

const USDT_ABI = [
	'function transfer(address to, uint256 amount) returns (bool)',
	'function approve(address spender, uint256 amount) returns (bool)',
	'function balanceOf(address) view returns (uint256)',
	'function decimals() view returns (uint8)',
	'function mint(address to, uint256 amount)'
];

export async function getUsdtDecimals(): Promise<number> {
	const { MockUSDT } = getDeployment();
	const usdt = new ethers.Contract(MockUSDT, USDT_ABI, getProvider());
	return Number(await usdt.decimals());
}

export async function fundWithUsdt(address: string, amount: string) {
	const { MockUSDT } = getDeployment();
	const signer = getSigner();
	const usdt = new ethers.Contract(MockUSDT, USDT_ABI, signer);
	const decimals = await getUsdtDecimals();
	const tx = await usdt.transfer(address, ethers.parseUnits(amount, decimals));
	await tx.wait();
}

export async function approveUsdt(spender: string, amount: string) {
	const { MockUSDT } = getDeployment();
	const signer = getSigner();
	const usdt = new ethers.Contract(MockUSDT, USDT_ABI, signer);
	const decimals = await getUsdtDecimals();
	const tx = await usdt.approve(spender, ethers.parseUnits(amount, decimals));
	await tx.wait();
}

export async function getUsdtBalance(address: string): Promise<bigint> {
	const { MockUSDT } = getDeployment();
	const usdt = new ethers.Contract(MockUSDT, USDT_ABI, getProvider());
	return await usdt.balanceOf(address);
}

// ── Token creation helpers ──

const FACTORY_ABI = [
	'function createToken(tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address paymentToken) p, address referral) external payable returns (address)',
	'function getCreatedTokens(address creator) external view returns (address[])',
	'function creationFee(uint8) view returns (uint256)',
	'function totalTokensCreated() view returns (uint256)',
	'event TokenCreated(address indexed creator, address indexed tokenAddress, uint8 tokenType, string name, string symbol, uint256 totalSupply, uint8 decimals)'
];

const TOKEN_TYPES = [
	{ name: 'Basic', isTaxable: false, isMintable: false, isPartner: false },
	{ name: 'Mintable', isTaxable: false, isMintable: true, isPartner: false },
	{ name: 'Taxable', isTaxable: true, isMintable: false, isPartner: false },
	{ name: 'TaxMintable', isTaxable: true, isMintable: true, isPartner: false },
	{ name: 'Partner', isTaxable: false, isMintable: false, isPartner: true },
	{ name: 'PartnerMintable', isTaxable: false, isMintable: true, isPartner: true },
	{ name: 'PartnerTaxable', isTaxable: true, isMintable: false, isPartner: true },
	{ name: 'PartnerTaxMintable', isTaxable: true, isMintable: true, isPartner: true }
];

export { TOKEN_TYPES };

export function getTokenTypeKey(isTaxable: boolean, isMintable: boolean, isPartner: boolean): number {
	return (isPartner ? 4 : 0) | (isTaxable ? 2 : 0) | (isMintable ? 1 : 0);
}

export async function createTokenDirect(
	name: string,
	symbol: string,
	supply: number,
	opts: { isTaxable?: boolean; isMintable?: boolean; isPartner?: boolean } = {}
): Promise<string> {
	const { TokenFactory, MockUSDT } = getDeployment();
	const signer = getSigner();
	const factory = new ethers.Contract(TokenFactory, FACTORY_ABI, signer);

	const typeKey = getTokenTypeKey(
		opts.isTaxable ?? false,
		opts.isMintable ?? false,
		opts.isPartner ?? false
	);
	const fee = await factory.creationFee(typeKey);

	// Approve USDT for fee
	const usdt = new ethers.Contract(MockUSDT, USDT_ABI, signer);
	await (await usdt.approve(TokenFactory, fee)).wait();

	const tx = await factory.createToken(
		{
			name,
			symbol,
			totalSupply: supply,
			decimals: 18,
			isTaxable: opts.isTaxable ?? false,
			isMintable: opts.isMintable ?? false,
			isPartner: opts.isPartner ?? false,
			paymentToken: MockUSDT
		},
		ethers.ZeroAddress
	);
	const receipt = await tx.wait();

	// Extract token address from event
	const event = receipt?.logs?.find((log: any) => {
		try {
			return factory.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === 'TokenCreated';
		} catch { return false; }
	});
	const parsed = factory.interface.parseLog({ topics: [...event!.topics], data: event!.data });
	return parsed!.args.tokenAddress;
}

// ── Launchpad helpers ──

const LAUNCHPAD_FACTORY_ABI = [
	'function createLaunch(address token_, uint256 totalTokens_, uint8 curveType_, uint256 softCap_, uint256 hardCap_, uint256 durationDays_, uint256 maxBuyBps_, uint256 creatorAllocationBps_, uint256 vestingDays_, address paymentToken_, uint256 startTimestamp_) external payable returns (address)',
	'function totalLaunches() view returns (uint256)',
	'function launches(uint256) view returns (address)',
	'event LaunchCreated(address indexed launch, address indexed token, address indexed creator, uint8 curveType, uint256 softCap, uint256 hardCap, uint256 totalTokens)'
];

const LAUNCH_INSTANCE_ABI = [
	'function buy(uint256 minUsdtOut, uint256 minTokensOut) external payable',
	'function buyWithToken(address paymentToken, uint256 amount, uint256 minUsdtOut, uint256 minTokensOut) external',
	'function depositTokens(uint256 amount) external',
	'function state() view returns (uint8)',
	'function tokensBought(address) view returns (uint256)',
	'function maxBuyPerWallet() view returns (uint256)',
	'function tokensForCurve() view returns (uint256)',
	'function totalBaseRaised() view returns (uint256)',
	'function getCurrentPrice() view returns (uint256)',
	'function previewBuy(uint256 baseAmount) view returns (uint256 tokensOut, uint256 fee, uint256 priceImpactBps)',
	'function getLaunchInfo() view returns (address token_, address creator_, uint8 curveType_, uint8 state_, uint256 softCap_, uint256 hardCap_, uint256 deadline_, uint256 totalBaseRaised_, uint256 tokensSold_, uint256 tokensForCurve_, uint256 tokensForLP_, uint256 creatorAllocationBps_, uint256 currentPrice_, address usdt_, uint256 startTimestamp_)'
];

const ERC20_ABI = [
	'function approve(address spender, uint256 amount) returns (bool)',
	'function balanceOf(address) view returns (uint256)',
	'function transfer(address to, uint256 amount) returns (bool)',
	'function enableTrading() external'
];

export async function createLaunchDirect(
	tokenAddress: string,
	opts: {
		totalTokens?: bigint;
		curveType?: number;
		softCap?: string;
		hardCap?: string;
		durationDays?: number;
		maxBuyBps?: number;
	} = {}
): Promise<string> {
	const { LaunchpadFactory } = getDeployment();
	const signer = getSigner();
	const factory = new ethers.Contract(LaunchpadFactory, LAUNCHPAD_FACTORY_ABI, signer);
	const usdtDecimals = await getUsdtDecimals();

	const totalTokens = opts.totalTokens ?? ethers.parseUnits('500000', 18);

	const tx = await factory.createLaunch(
		tokenAddress,
		totalTokens,
		opts.curveType ?? 0, // Linear
		ethers.parseUnits(opts.softCap ?? '100', usdtDecimals),
		ethers.parseUnits(opts.hardCap ?? '10000', usdtDecimals),
		opts.durationDays ?? 30,
		opts.maxBuyBps ?? 200, // 2%
		0, // no creator allocation
		0, // no vesting
		ethers.ZeroAddress, // native payment for fee (fee is 0)
		0  // start immediately
	);
	const receipt = await tx.wait();

	const event = receipt?.logs?.find((log: any) => {
		try {
			return factory.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === 'LaunchCreated';
		} catch { return false; }
	});
	const parsed = factory.interface.parseLog({ topics: [...event!.topics], data: event!.data });
	return parsed!.args.launch;
}

export async function depositAndActivateLaunch(
	tokenAddress: string,
	launchAddress: string,
	amount: bigint
) {
	const signer = getSigner();
	const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
	const launch = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, signer);

	await (await token.approve(launchAddress, amount)).wait();
	await (await launch.depositTokens(amount)).wait();
}

export async function enableTrading(tokenAddress: string) {
	const signer = getSigner();
	const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
	try {
		await (await token.enableTrading()).wait();
	} catch {
		// Not all token types have enableTrading
	}
}

export async function buyTokensWithUsdt(
	launchAddress: string,
	usdtAmount: string
): Promise<bigint> {
	const { MockUSDT } = getDeployment();
	const signer = getSigner();
	const usdtDecimals = await getUsdtDecimals();
	const amount = ethers.parseUnits(usdtAmount, usdtDecimals);

	// Approve USDT
	const usdt = new ethers.Contract(MockUSDT, USDT_ABI, signer);
	await (await usdt.approve(launchAddress, amount)).wait();

	// Buy
	const launch = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, signer);
	const tx = await launch.buyWithToken(MockUSDT, amount, 0, 0);
	await tx.wait();

	// Return tokens bought
	return await launch.tokensBought(await signer.getAddress());
}

export async function getLaunchState(launchAddress: string): Promise<number> {
	const launch = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, getProvider());
	return Number(await launch.state());
}

export async function getMaxBuyPerWallet(launchAddress: string): Promise<bigint> {
	const launch = new ethers.Contract(launchAddress, LAUNCH_INSTANCE_ABI, getProvider());
	return await launch.maxBuyPerWallet();
}

// ── PlatformRouter helpers ──

const ROUTER_ABI = [
	'function createTokenAndLaunch(tuple(string name, string symbol, uint256 totalSupply, uint8 decimals, bool isTaxable, bool isMintable, bool isPartner, address paymentToken) p, tuple(uint256 tokensForLaunch, uint8 curveType, uint256 softCap, uint256 hardCap, uint256 durationDays, uint256 maxBuyBps, uint256 creatorAllocationBps, uint256 vestingDays, address launchPaymentToken, uint256 startTimestamp) launch, tuple(uint256 maxWalletAmount, uint256 maxTransactionAmount, uint256 cooldownSeconds) protection, tuple(uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, address[] taxWallets, uint16[] taxSharesBps) tax, address referral) external payable returns (address tokenAddress, address launchAddress)',
	'event TokenCreatedAndLaunched(address indexed creator, address indexed token, address indexed launch)'
];

export async function createTokenAndLaunchDirect(
	name: string,
	symbol: string,
	supply: number,
	opts: {
		isTaxable?: boolean;
		isMintable?: boolean;
		isPartner?: boolean;
		tokensForLaunchPct?: number;
		curveType?: number;
		softCap?: string;
		hardCap?: string;
		durationDays?: number;
		maxBuyBps?: number;
	} = {}
): Promise<{ tokenAddress: string; launchAddress: string }> {
	const { PlatformRouter, MockUSDT } = getDeployment();
	const signer = getSigner();
	const router = new ethers.Contract(PlatformRouter, ROUTER_ABI, signer);
	const usdtDecimals = await getUsdtDecimals();

	const typeKey = getTokenTypeKey(
		opts.isTaxable ?? false,
		opts.isMintable ?? false,
		opts.isPartner ?? false
	);

	// Approve USDT for creation fee
	const factoryContract = new ethers.Contract(getDeployment().TokenFactory, FACTORY_ABI, getSigner());
	const fee = await factoryContract.creationFee(typeKey);
	const usdt = new ethers.Contract(MockUSDT, USDT_ABI, signer);
	await (await usdt.approve(PlatformRouter, fee)).wait();

	const totalSupplyWei = BigInt(supply) * (10n ** 18n);
	const pct = opts.tokensForLaunchPct ?? 80;
	const tokensForLaunch = (totalSupplyWei * BigInt(pct)) / 100n;

	const tx = await router.createTokenAndLaunch(
		{
			name, symbol,
			totalSupply: supply,
			decimals: 18,
			isTaxable: opts.isTaxable ?? false,
			isMintable: opts.isMintable ?? false,
			isPartner: opts.isPartner ?? false,
			paymentToken: MockUSDT
		},
		{
			tokensForLaunch,
			curveType: opts.curveType ?? 0,
			softCap: ethers.parseUnits(opts.softCap ?? '100', usdtDecimals),
			hardCap: ethers.parseUnits(opts.hardCap ?? '10000', usdtDecimals),
			durationDays: opts.durationDays ?? 30,
			maxBuyBps: opts.maxBuyBps ?? 200,
			creatorAllocationBps: 0,
			vestingDays: 0,
			launchPaymentToken: MockUSDT,
			startTimestamp: 0
		},
		{ maxWalletAmount: 0, maxTransactionAmount: 0, cooldownSeconds: 0 },
		{ buyTaxBps: 0, sellTaxBps: 0, transferTaxBps: 0, taxWallets: [], taxSharesBps: [] },
		ethers.ZeroAddress
	);
	const receipt = await tx.wait();

	const event = receipt?.logs?.find((log: any) => {
		try {
			return router.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === 'TokenCreatedAndLaunched';
		} catch { return false; }
	});
	const parsed = router.interface.parseLog({ topics: [...event!.topics], data: event!.data });
	return {
		tokenAddress: parsed!.args.token,
		launchAddress: parsed!.args.launch
	};
}
