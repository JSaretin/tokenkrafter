/**
 * SafuLens — batch SAFU badge detection via eth_call.
 *
 * Deploys the SafuLens constructor bytecode in a simulated call (never
 * on-chain), which reads token/pair/factory state for N tokens at once
 * and returns per-token badge data. One RPC round-trip for the whole batch.
 */
import { ethers } from 'ethers';

// The SafuLens bytecode is loaded once from the compiled artifact.
// Bun/vite will resolve this at build time.
let _bytecode: string | null = null;

export async function loadSafuBytecode(): Promise<string> {
	if (_bytecode) return _bytecode;
	try {
		const mod = await import('../../solidty-contracts/artifacts/contracts/simulators/SafuLens.sol/SafuLens.json');
		_bytecode = mod.default?.bytecode || mod.bytecode;
	} catch {
		// Fallback: fetch from a known path if the import fails
		throw new Error('SafuLens bytecode not found');
	}
	return _bytecode!;
}

export interface TokenSafu {
	token: string;
	isMintable: boolean;
	isTaxable: boolean;
	isPartner: boolean;
	owner: string;
	ownerIsZero: boolean;
	taxCeilingLocked: boolean;
	buyTaxBps: number;
	sellTaxBps: number;
	transferTaxBps: number;
	tradingEnabled: boolean;
	hasLiquidity: boolean;
	lpBurned: boolean;
	lpBurnedPct: number; // 0-10000 bps
	isSafu: boolean;
}

/**
 * Batch-query SAFU badges for multiple tokens in one eth_call.
 *
 * @param provider   ethers Provider
 * @param tokenFactory  TokenFactory contract address
 * @param dexFactory    DEX factory (PancakeFactory) address
 * @param weth          Wrapped native coin (WBNB) address
 * @param usdt          USDT address on this chain
 * @param tokenAddrs    Array of token addresses to check
 * @returns             Array of TokenSafu results (same order as input)
 */
export async function querySafuLens(
	provider: ethers.Provider,
	tokenFactory: string,
	dexFactory: string,
	weth: string,
	usdt: string,
	tokenAddrs: string[],
): Promise<TokenSafu[]> {
	if (tokenAddrs.length === 0) return [];

	const bytecode = await loadSafuBytecode();
	const abiCoder = ethers.AbiCoder.defaultAbiCoder();

	const constructorArgs = abiCoder.encode(
		['address', 'address', 'address', 'address', 'address[]'],
		[tokenFactory, dexFactory, weth, usdt, tokenAddrs]
	);

	const callData = bytecode + constructorArgs.slice(2);
	const raw = await provider.call({ data: callData, gasLimit: 50_000_000 });

	if (!raw || raw === '0x') return [];

	const decoded = abiCoder.decode(
		['tuple(address token, bool isMintable, bool isTaxable, bool isPartner, address owner, bool ownerIsZero, bool taxCeilingLocked, uint256 buyTaxBps, uint256 sellTaxBps, uint256 transferTaxBps, bool tradingEnabled, bool hasLiquidity, bool lpBurned, uint256 lpBurnedPct, bool isSafu)[]'],
		raw
	);

	return (decoded[0] as any[]).map((s: any) => ({
		token: s.token.toLowerCase(),
		isMintable: s.isMintable,
		isTaxable: s.isTaxable,
		isPartner: s.isPartner,
		owner: s.owner,
		ownerIsZero: s.ownerIsZero,
		taxCeilingLocked: s.taxCeilingLocked,
		buyTaxBps: Number(s.buyTaxBps),
		sellTaxBps: Number(s.sellTaxBps),
		transferTaxBps: Number(s.transferTaxBps),
		tradingEnabled: s.tradingEnabled,
		hasLiquidity: s.hasLiquidity,
		lpBurned: s.lpBurned,
		lpBurnedPct: Number(s.lpBurnedPct),
		isSafu: s.isSafu,
	}));
}
