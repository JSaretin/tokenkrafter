import { ethers } from 'ethers';

/**
 * UniswapV2-style DEX interface surface the platform actually calls.
 * Mirrors /solidty-contracts/contracts/shared/DexInterfaces.sol.
 *
 * Note: `addLiquidity` / `addLiquidityETH` are intentionally absent — every
 * seeding path uses direct-transfer + pair.mint() instead.
 */

// ── Router write params ───────────────────────────────────────────────

export interface SwapExactTokensForTokensParams {
	amountIn: string;
	amountOutMin: string;
	path: string[];
	to: string;
	deadline: number;
	tokenInDecimals: number;
	tokenOutDecimals: number;
}
export interface SwapExactTokensForTokensParamsRaw {
	amountIn: bigint;
	amountOutMin: bigint;
	path: string[];
	to: string;
	deadline: bigint;
}

export interface SwapExactETHForTokensParams {
	amountIn: string;          // ETH msg.value
	amountOutMin: string;
	path: string[];
	to: string;
	deadline: number;
	tokenOutDecimals: number;
}
export interface SwapExactETHForTokensParamsRaw {
	value: bigint;
	amountOutMin: bigint;
	path: string[];
	to: string;
	deadline: bigint;
}

export interface SwapTokensForExactTokensParams {
	amountOut: string;
	amountInMax: string;
	path: string[];
	to: string;
	deadline: number;
	tokenInDecimals: number;
	tokenOutDecimals: number;
}
export interface SwapTokensForExactTokensParamsRaw {
	amountOut: bigint;
	amountInMax: bigint;
	path: string[];
	to: string;
	deadline: bigint;
}

export interface SwapETHForExactTokensParams {
	amountOut: string;
	amountInMax: string;       // ETH msg.value cap
	path: string[];
	to: string;
	deadline: number;
	tokenOutDecimals: number;
}
export interface SwapETHForExactTokensParamsRaw {
	amountOut: bigint;
	value: bigint;
	path: string[];
	to: string;
	deadline: bigint;
}

// ── Router read types ───────────────────────────────────────────────

export interface AmountsQuery {
	amount: string;            // human-readable amountIn / amountOut
	path: string[];
	inputDecimals: number;     // decimals of path[0] for amountsOut, or path[last] for amountsIn
}

export interface AmountsResultView {
	amounts: string[];         // formatted at each path hop's decimals (caller supplies)
}

// ── Pair read types ─────────────────────────────────────────────────

export interface ReservesRaw {
	reserve0: bigint;
	reserve1: bigint;
	blockTimestampLast: bigint;
}

export interface ReservesView {
	reserve0: string;
	reserve1: string;
	blockTimestampLast: Date;
}

// ── Converters ──────────────────────────────────────────────────────

export function toSwapExactTokensForTokensRaw(p: SwapExactTokensForTokensParams): SwapExactTokensForTokensParamsRaw {
	return {
		amountIn: ethers.parseUnits(p.amountIn || '0', p.tokenInDecimals),
		amountOutMin: ethers.parseUnits(p.amountOutMin || '0', p.tokenOutDecimals),
		path: p.path,
		to: p.to,
		deadline: BigInt(p.deadline),
	};
}

export function toSwapExactETHForTokensRaw(p: SwapExactETHForTokensParams): SwapExactETHForTokensParamsRaw {
	return {
		value: ethers.parseEther(p.amountIn || '0'),
		amountOutMin: ethers.parseUnits(p.amountOutMin || '0', p.tokenOutDecimals),
		path: p.path,
		to: p.to,
		deadline: BigInt(p.deadline),
	};
}

export function toSwapTokensForExactTokensRaw(p: SwapTokensForExactTokensParams): SwapTokensForExactTokensParamsRaw {
	return {
		amountOut: ethers.parseUnits(p.amountOut || '0', p.tokenOutDecimals),
		amountInMax: ethers.parseUnits(p.amountInMax || '0', p.tokenInDecimals),
		path: p.path,
		to: p.to,
		deadline: BigInt(p.deadline),
	};
}

export function toSwapETHForExactTokensRaw(p: SwapETHForExactTokensParams): SwapETHForExactTokensParamsRaw {
	return {
		amountOut: ethers.parseUnits(p.amountOut || '0', p.tokenOutDecimals),
		value: ethers.parseEther(p.amountInMax || '0'),
		path: p.path,
		to: p.to,
		deadline: BigInt(p.deadline),
	};
}

export function toAmountsView(amounts: bigint[], decimalsPerHop: number[]): AmountsResultView {
	return {
		amounts: amounts.map((a, i) => ethers.formatUnits(a, decimalsPerHop[i] ?? 18)),
	};
}

export function toReservesView(
	raw: ReservesRaw,
	token0Decimals = 18,
	token1Decimals = 18
): ReservesView {
	return {
		reserve0: ethers.formatUnits(raw.reserve0, token0Decimals),
		reserve1: ethers.formatUnits(raw.reserve1, token1Decimals),
		blockTimestampLast: new Date(Number(raw.blockTimestampLast) * 1000),
	};
}
