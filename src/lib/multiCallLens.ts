import { ethers } from 'ethers';
import MultiCallLensArtifact from '../../solidty-contracts/artifacts/contracts/simulators/MultiCallLens.sol/MultiCallLens.json';

// ── Types ──

export interface PlatformData {
	tfOwner: string;
	tfTotalTokens: bigint;
	tfTotalFeeUsdt: bigint;
	tfFeesPerType: bigint[];
	tfCountPerType: bigint[];
	lpOwner: string;
	lpTotalLaunches: bigint;
	lpTotalFeeUsdt: bigint;
	lpLaunchFee: bigint;
	trOwner: string;
	trFeeBps: bigint;
	trPayoutTimeout: bigint;
	trPlatformWallet: string;
	trTotalEscrow: bigint;
	trPendingCount: bigint;
	trTotalWithdrawals: bigint;
	trPaused: boolean;
	trAffiliateEnabled: boolean;
	nativePriceUsdt: bigint;
}

export interface TokenData {
	addr: string;
	name: string;
	symbol: string;
	decimals: number;
	totalSupply: bigint;
	userBalance: bigint;
	creator: string;
	isMintable: boolean;
	isTaxable: boolean;
	isPartner: boolean;
}

export interface BalanceData {
	token: string;
	balance: bigint;
	decimals: number;
}

export interface MultiCallResult {
	platform: PlatformData;
	tokens: TokenData[];
	balances: BalanceData[];
}

// ABI types for decoding the return data
const RESULT_TYPES = [
	// PlatformData struct
	'tuple(address tfOwner, uint256 tfTotalTokens, uint256 tfTotalFeeUsdt, uint256[8] tfFeesPerType, uint256[8] tfCountPerType, address lpOwner, uint256 lpTotalLaunches, uint256 lpTotalFeeUsdt, uint256 lpLaunchFee, address trOwner, uint256 trFeeBps, uint256 trPayoutTimeout, address trPlatformWallet, uint256 trTotalEscrow, uint256 trPendingCount, uint256 trTotalWithdrawals, bool trPaused, bool trAffiliateEnabled, uint256 nativePriceUsdt)',
	// TokenData[] struct
	'tuple(address addr, string name, string symbol, uint8 decimals, uint256 totalSupply, uint256 userBalance, address creator, bool isMintable, bool isTaxable, bool isPartner)[]',
	// BalanceInfo[] struct
	'tuple(address token, uint256 balance, uint8 decimals)[]',
];

const CONSTRUCTOR_TYPES = [
	'address', // tokenFactory
	'address', // launchpadFactory
	'address', // tradeRouter
	'address', // usdt
	'address', // dexRouter
	'address', // user
	'address[]', // tokens
	'address[]', // balanceTokens
];

/**
 * Single RPC call to fetch ALL platform data:
 * - Platform state (TokenFactory + LaunchpadFactory + TradeRouter + BNB price)
 * - Token batch info (metadata, balances, creator)
 * - User balance batch (ERC20 + native)
 *
 * Pass empty arrays for tokens/balanceTokens to skip those.
 * Pass ethers.ZeroAddress for user to skip balance reads.
 */
export async function multiCall(
	provider: ethers.JsonRpcProvider,
	config: {
		tokenFactory: string;
		launchpadFactory: string;
		tradeRouter: string;
		usdt: string;
		dexRouter: string;
	},
	user: string = ethers.ZeroAddress,
	tokens: string[] = [],
	balanceTokens: string[] = [],
): Promise<MultiCallResult> {
	const coder = ethers.AbiCoder.defaultAbiCoder();
	const args = coder.encode(CONSTRUCTOR_TYPES, [
		config.tokenFactory,
		config.launchpadFactory,
		config.tradeRouter,
		config.usdt,
		config.dexRouter,
		user,
		tokens,
		balanceTokens,
	]);

	const data = MultiCallLensArtifact.bytecode + args.slice(2);
	const result = await provider.call({ data });
	const [p, t, b] = coder.decode(RESULT_TYPES, result);

	return {
		platform: {
			tfOwner: p.tfOwner,
			tfTotalTokens: p.tfTotalTokens,
			tfTotalFeeUsdt: p.tfTotalFeeUsdt,
			tfFeesPerType: [...p.tfFeesPerType],
			tfCountPerType: [...p.tfCountPerType],
			lpOwner: p.lpOwner,
			lpTotalLaunches: p.lpTotalLaunches,
			lpTotalFeeUsdt: p.lpTotalFeeUsdt,
			lpLaunchFee: p.lpLaunchFee,
			trOwner: p.trOwner,
			trFeeBps: p.trFeeBps,
			trPayoutTimeout: p.trPayoutTimeout,
			trPlatformWallet: p.trPlatformWallet,
			trTotalEscrow: p.trTotalEscrow,
			trPendingCount: p.trPendingCount,
			trTotalWithdrawals: p.trTotalWithdrawals,
			trPaused: p.trPaused,
			trAffiliateEnabled: p.trAffiliateEnabled,
			nativePriceUsdt: p.nativePriceUsdt,
		},
		tokens: t.map((tk: any) => ({
			addr: tk.addr,
			name: tk.name,
			symbol: tk.symbol,
			decimals: Number(tk.decimals),
			totalSupply: tk.totalSupply,
			userBalance: tk.userBalance,
			creator: tk.creator,
			isMintable: tk.isMintable,
			isTaxable: tk.isTaxable,
			isPartner: tk.isPartner,
		})),
		balances: b.map((bl: any) => ({
			token: bl.token,
			balance: bl.balance,
			decimals: Number(bl.decimals),
		})),
	};
}
