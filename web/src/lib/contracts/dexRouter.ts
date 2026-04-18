import { ethers } from 'ethers';
import { DEX_ROUTER_ABI as SHARED_DEX_ROUTER_ABI } from '../tradeRouter';

/**
 * Self-contained ABI for a Uniswap V2 / PancakeSwap-compatible router.
 * Starts from the shared `DEX_ROUTER_ABI` (kept minimal for trade-router use)
 * and extends it with the entries this client needs (`factory`, `getAmountsIn`).
 * We deliberately avoid mutating the shared constant — other call-sites only
 * need a subset and shouldn't be forced onto our richer surface.
 */
const DEX_ROUTER_ABI = [
	...SHARED_DEX_ROUTER_ABI,
	'function factory() view returns (address)',
	'function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[])',
	'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
	'function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)',
] as const;

// ════════════════════════════════════════════════════════════════════════════
//  Public result / param shapes
// ════════════════════════════════════════════════════════════════════════════

export interface TxResult {
	tx: ethers.TransactionResponse;
	receipt: ethers.TransactionReceipt | null;
}

/**
 * Unified swap parameters for the smart `swap()` helper. `fromNative` /
 * `toNative` drive which router overload the client selects:
 *  - `fromNative` → `swapExactETHForTokensSupportingFeeOnTransferTokens`
 *  - `toNative`   → `swapExactTokensForETHSupportingFeeOnTransferTokens`
 *  - otherwise     → `swapExactTokensForTokensSupportingFeeOnTransferTokens`
 */
export interface SwapParams {
	amountIn: bigint;
	minOut: bigint;
	path: string[];
	to: string;
	deadline: number;
	/** True if `path[0]` is the native wrapper (WETH / WBNB). */
	fromNative: boolean;
	/** True if `path[path.length-1]` is the native wrapper. */
	toNative: boolean;
	/** Gas-buffer in basis points on top of `estimateGas`. Default: 3000 (30%). */
	gasBufferBps?: number;
}

/** Result of `findBestRouteQuote`: the candidate path with the highest output. */
export interface RouteQuote {
	path: string[];
	amountOut: bigint;
}

// ════════════════════════════════════════════════════════════════════════════
//  Client
// ════════════════════════════════════════════════════════════════════════════

/**
 * Typed wrapper around a Uniswap V2 / PancakeSwap V2-compatible router.
 *
 * The V2 router emits no events itself — pair-level `Swap` / `Sync` events
 * come from the pair contracts — so this client exposes no event helpers.
 *
 * Constructor accepts a provider (reads only) or a signer (reads + writes).
 * Use `connect(signer)` to derive a signer-backed instance from a read-only
 * one.
 */
export class DexRouterClient {
	readonly contract: ethers.Contract;

	constructor(address: string, signerOrProvider: ethers.Signer | ethers.Provider) {
		this.contract = new ethers.Contract(address, DEX_ROUTER_ABI, signerOrProvider);
	}

	/** New instance bound to a signer (required for write methods). */
	connect(signer: ethers.Signer): DexRouterClient {
		return new DexRouterClient(this.contract.target as string, signer);
	}

	// ── Reads ──────────────────────────────────────────────

	async weth(): Promise<string> {
		return this.contract.WETH();
	}

	async factory(): Promise<string> {
		return this.contract.factory();
	}

	async getAmountsOut(amountIn: bigint, path: string[]): Promise<bigint[]> {
		const amounts: bigint[] = await this.contract.getAmountsOut(amountIn, path);
		return amounts.map((a) => BigInt(a));
	}

	async getAmountsIn(amountOut: bigint, path: string[]): Promise<bigint[]> {
		const amounts: bigint[] = await this.contract.getAmountsIn(amountOut, path);
		return amounts.map((a) => BigInt(a));
	}

	// ── Writes (signer required) ───────────────────────────

	/**
	 * Native-in swap (`swapExactETHForTokensSupportingFeeOnTransferTokens`).
	 * `opts.value` must equal `amountIn` — there's no separate amountIn arg.
	 */
	async swapExactETHForTokens(
		path: string[],
		minOut: bigint,
		to: string,
		deadline: number,
		opts: { value: bigint; gasBufferBps?: number },
	): Promise<TxResult> {
		const fn = this.contract.swapExactETHForTokensSupportingFeeOnTransferTokens;
		const overrides: ethers.Overrides = { value: opts.value };
		const est = await fn.estimateGas(minOut, path, to, deadline, overrides);
		overrides.gasLimit = this._withBuffer(est, opts.gasBufferBps);
		const tx = (await fn(minOut, path, to, deadline, overrides)) as ethers.TransactionResponse;
		const receipt = await tx.wait();
		return { tx, receipt };
	}

	/** Token→native swap (`swapExactTokensForETHSupportingFeeOnTransferTokens`). */
	async swapExactTokensForETH(
		amountIn: bigint,
		minOut: bigint,
		path: string[],
		to: string,
		deadline: number,
		opts: { gasBufferBps?: number } = {},
	): Promise<TxResult> {
		const fn = this.contract.swapExactTokensForETHSupportingFeeOnTransferTokens;
		const est = await fn.estimateGas(amountIn, minOut, path, to, deadline);
		const tx = (await fn(amountIn, minOut, path, to, deadline, {
			gasLimit: this._withBuffer(est, opts.gasBufferBps),
		})) as ethers.TransactionResponse;
		const receipt = await tx.wait();
		return { tx, receipt };
	}

	/** Token→token swap (`swapExactTokensForTokensSupportingFeeOnTransferTokens`). */
	async swapExactTokensForTokens(
		amountIn: bigint,
		minOut: bigint,
		path: string[],
		to: string,
		deadline: number,
		opts: { gasBufferBps?: number } = {},
	): Promise<TxResult> {
		const fn = this.contract.swapExactTokensForTokensSupportingFeeOnTransferTokens;
		const est = await fn.estimateGas(amountIn, minOut, path, to, deadline);
		const tx = (await fn(amountIn, minOut, path, to, deadline, {
			gasLimit: this._withBuffer(est, opts.gasBufferBps),
		})) as ethers.TransactionResponse;
		const receipt = await tx.wait();
		return { tx, receipt };
	}

	// ── Convenience: smart swap dispatcher ─────────────────

	/**
	 * Dispatches to the correct `swapExact*` overload based on `fromNative` /
	 * `toNative`. Callers build the path once and set the native flags based
	 * on whether the first / last hop is WETH; the client picks the overload.
	 *
	 * Estimates gas, applies `gasBufferBps` (default 30%), and submits.
	 */
	async swap(params: SwapParams): Promise<TxResult> {
		const { amountIn, minOut, path, to, deadline, fromNative, toNative, gasBufferBps } = params;

		if (fromNative) {
			return this.swapExactETHForTokens(path, minOut, to, deadline, {
				value: amountIn,
				gasBufferBps,
			});
		}
		if (toNative) {
			return this.swapExactTokensForETH(amountIn, minOut, path, to, deadline, { gasBufferBps });
		}
		return this.swapExactTokensForTokens(amountIn, minOut, path, to, deadline, { gasBufferBps });
	}

	// ── Utilities ──────────────────────────────────────────

	/**
	 * Quote an input `amountIn` across several candidate paths and return the
	 * one with the highest output. Useful for picking between direct and
	 * multi-hop routes (e.g. `[A, B]` vs `[A, WETH, B]`).
	 *
	 * Paths that revert on `getAmountsOut` (e.g. no pool along that hop) are
	 * silently skipped. Throws if no candidate produces a valid quote.
	 */
	async findBestRouteQuote(amountIn: bigint, paths: string[][]): Promise<RouteQuote> {
		if (paths.length === 0) {
			throw new Error('findBestRouteQuote: at least one candidate path is required');
		}

		const quotes = await Promise.all(
			paths.map(async (path): Promise<RouteQuote | null> => {
				try {
					const amounts = await this.getAmountsOut(amountIn, path);
					if (amounts.length === 0) return null;
					return { path, amountOut: amounts[amounts.length - 1] };
				} catch {
					return null;
				}
			}),
		);

		let best: RouteQuote | null = null;
		for (const q of quotes) {
			if (!q) continue;
			if (!best || q.amountOut > best.amountOut) best = q;
		}
		if (!best) throw new Error('findBestRouteQuote: no candidate path produced a valid quote');
		return best;
	}

	// ── Liquidity ───────────────────────────────────────────

	/**
	 * Add liquidity to a token/token pair. Creates the pair if it doesn't
	 * exist. Requires prior approval of both `tokenA` and `tokenB` to this
	 * router for at least the desired amounts. The `amountAMin` / `amountBMin`
	 * slippage floors protect the caller if the pool ratio moves between
	 * quote and execution; pass `0n` on pair creation when no ratio exists yet.
	 */
	async addLiquidity(params: {
		tokenA: string;
		tokenB: string;
		amountADesired: bigint;
		amountBDesired: bigint;
		amountAMin?: bigint;
		amountBMin?: bigint;
		to: string;
		deadline: number;
		gasBufferBps?: number;
	}): Promise<TxResult> {
		const gas = await this.contract.addLiquidity.estimateGas(
			params.tokenA,
			params.tokenB,
			params.amountADesired,
			params.amountBDesired,
			params.amountAMin ?? 0n,
			params.amountBMin ?? 0n,
			params.to,
			params.deadline,
		);
		const tx = await this.contract.addLiquidity(
			params.tokenA,
			params.tokenB,
			params.amountADesired,
			params.amountBDesired,
			params.amountAMin ?? 0n,
			params.amountBMin ?? 0n,
			params.to,
			params.deadline,
			{ gasLimit: this._withBuffer(gas, params.gasBufferBps) },
		);
		const receipt = await tx.wait();
		return { tx, receipt };
	}

	/**
	 * Add liquidity to a token/native pair. The native amount is `msg.value`;
	 * pass it via `opts.value`. Requires prior approval of `token` to this
	 * router for at least `amountTokenDesired`.
	 */
	async addLiquidityETH(params: {
		token: string;
		amountTokenDesired: bigint;
		amountETH: bigint;
		amountTokenMin?: bigint;
		amountETHMin?: bigint;
		to: string;
		deadline: number;
		gasBufferBps?: number;
	}): Promise<TxResult> {
		const gas = await this.contract.addLiquidityETH.estimateGas(
			params.token,
			params.amountTokenDesired,
			params.amountTokenMin ?? 0n,
			params.amountETHMin ?? 0n,
			params.to,
			params.deadline,
			{ value: params.amountETH },
		);
		const tx = await this.contract.addLiquidityETH(
			params.token,
			params.amountTokenDesired,
			params.amountTokenMin ?? 0n,
			params.amountETHMin ?? 0n,
			params.to,
			params.deadline,
			{ value: params.amountETH, gasLimit: this._withBuffer(gas, params.gasBufferBps) },
		);
		const receipt = await tx.wait();
		return { tx, receipt };
	}

	// ── Internals ──────────────────────────────────────────

	private _withBuffer(gas: bigint, bps: number | undefined): bigint {
		const b = BigInt(bps ?? 3000);
		return (gas * (10000n + b)) / 10000n;
	}
}
