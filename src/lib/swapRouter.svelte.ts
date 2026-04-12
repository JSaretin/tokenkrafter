/**
 * SwapRouter — reactive best-route finder with tax simulation.
 *
 * Wraps `findBestRoute()` and `queryTradeLens()` in a Svelte 5 rune-powered
 * class so any component can get instant quotes, optimal swap paths, and
 * accurate tax-adjusted minOut without duplicating logic.
 *
 * Usage:
 *   const router = new SwapRouter();
 *
 *   // Required inputs
 *   router.tokenIn  = '0x…';
 *   router.tokenOut  = '0x…';
 *   router.amountIn  = '1.5';
 *   router.decimalsIn  = 18;
 *   router.decimalsOut = 18;
 *
 *   // For on-chain validation + tax simulation
 *   router.provider = ethersProvider;
 *   router.tradeRouterAddress = '0x…';    // platform TradeRouter
 *   router.dexRouterAddress   = '0x…';    // PancakeSwap router
 *   router.usdtAddress        = '0x…';    // for tax sim base tokens
 *   router.usdcAddress        = '0x…';    // optional
 *   router.chainId             = 56;
 *   router.userAddress         = '0x…';   // for balance queries
 *
 *   // Reads:
 *   router.route       // SwapRoute | null
 *   router.amountOut    // formatted string
 *   router.minOut       // bigint (tax + slippage adjusted)
 *   router.taxIn        // TaxInfo | null (sell side)
 *   router.taxOut       // TaxInfo | null (buy side)
 *   router.noLiquidity  // boolean
 *   router.loading      // boolean
 */

import { ethers } from 'ethers';
import {
	findBestRoute,
	queryTradeLens,
	getWeth,
	isCacheLoaded,
	type SwapRoute,
	type TaxInfo,
} from './tradeLens';
import { TRADE_ROUTER_ABI } from './tradeRouter';

export type { SwapRoute, TaxInfo };

export class SwapRouter {
	// ── Inputs (set by consumer) ──────────────────────────────────
	tokenIn = $state('');
	tokenOut = $state('');
	amountIn = $state('');
	decimalsIn = $state(18);
	decimalsOut = $state(18);

	/** If true, tokenIn is the chain's native coin (BNB/ETH). */
	tokenInIsNative = $state(false);
	/** If true, tokenOut is the chain's native coin. */
	tokenOutIsNative = $state(false);

	/** Slippage tolerance in basis points (e.g. 50 = 0.5%). */
	slippageBps = $state(50);

	/** ethers Provider for on-chain validation + tax simulation. */
	provider: ethers.Provider | null = $state(null);
	/** Platform TradeRouter contract address (for getAmountOut). */
	tradeRouterAddress = $state('');
	/** DEX router address (PancakeSwap, etc.) — needed by TradeLens sim. */
	dexRouterAddress = $state('');
	/** USDT address on this chain — used as tax sim base token. */
	usdtAddress = $state('');
	/** USDC address on this chain (optional extra base). */
	usdcAddress = $state('');
	/** Chain ID for TradeLens queries. */
	chainId = $state(0);
	/** User wallet address (for balance queries in TradeLens). */
	userAddress = $state('');

	// ── Outputs (read by consumer) ────────────────────────────────
	route = $state<SwapRoute | null>(null);
	amountOut = $state('');
	noLiquidity = $state(false);
	loading = $state(false);

	/** Tax info for tokenIn (sell-side tax applies when selling this token). */
	taxIn = $state<TaxInfo | null>(null);
	/** Tax info for tokenOut (buy-side tax applies when buying this token). */
	taxOut = $state<TaxInfo | null>(null);
	/** True while tax simulation is in-flight. */
	taxLoading = $state(false);

	/**
	 * Minimum acceptable output after slippage + taxes — ready to pass
	 * straight into the swap contract's `minOut` parameter.
	 *
	 * Calculation: amountOut * (1 - sellTax) * (1 - buyTax) * (1 - slippage)
	 * This is conservative: the on-chain quote may already include taxes
	 * (depends on whether the lens used SupportingFeeOnTransfer), but
	 * double-deducting is safer than under-deducting and getting reverted.
	 */
	minOut = $derived.by(() => {
		if (!this.amountOut || !this.route) return 0n;
		try {
			let raw = ethers.parseUnits(this.amountOut, this.decimalsOut);

			// Deduct sell tax on tokenIn
			const sellTax = this.taxIn?.sellTaxBps || 0;
			if (sellTax > 0) raw = (raw * BigInt(10000 - sellTax)) / 10000n;

			// Deduct buy tax on tokenOut
			const buyTax = this.taxOut?.buyTaxBps || 0;
			if (buyTax > 0) raw = (raw * BigInt(10000 - buyTax)) / 10000n;

			// Deduct slippage
			return (raw * BigInt(10000 - this.slippageBps)) / 10000n;
		} catch {
			return 0n;
		}
	});

	/** Total tax impact in bps (sell + buy) for display purposes. */
	totalTaxBps = $derived((this.taxIn?.sellTaxBps || 0) + (this.taxOut?.buyTaxBps || 0));

	/** True if either token has a non-zero tax. */
	hasTax = $derived(this.totalTaxBps > 0);

	/** True if either token failed the buy/sell simulation (honeypot signal). */
	honeypotWarning = $derived(
		(this.taxIn !== null && !this.taxIn.success) ||
		(this.taxOut !== null && !this.taxOut.success)
	);

	// ── Internals ─────────────────────────────────────────────────
	private _quoteTimeout: ReturnType<typeof setTimeout> | null = null;
	private _lastTaxIn = '';
	private _lastTaxOut = '';

	constructor() {
		// Quote effect — fires on amount / token changes
		$effect(() => {
			this._computeQuote();
		});

		// Tax simulation effect — fires only when tokens change (not amount)
		$effect(() => {
			this._computeTax();
		});
	}

	/** Clear all outputs. */
	reset() {
		this.route = null;
		this.amountOut = '';
		this.noLiquidity = false;
		this.loading = false;
		this.taxIn = null;
		this.taxOut = null;
		this.taxLoading = false;
		this._lastTaxIn = '';
		this._lastTaxOut = '';
		if (this._quoteTimeout) {
			clearTimeout(this._quoteTimeout);
			this._quoteTimeout = null;
		}
	}

	// ── Path building helpers (static, reusable) ──────────────────

	/** Build the optimal swap path, using the cached route if available. */
	buildSwapPath(weth?: string): string[] {
		const w = weth || getWeth();
		if (this.route?.path?.length) return [...this.route.path];
		const inAddr = this.tokenInIsNative ? w : this.tokenIn;
		const outAddr = this.tokenOutIsNative ? w : this.tokenOut;
		if (inAddr !== w && outAddr !== w) return [inAddr, w, outAddr];
		return [inAddr, outAddr];
	}

	/** Build a deposit/off-ramp path that ends with `targetToken` (e.g. USDT). */
	buildDepositPath(targetToken: string, weth?: string): string[] {
		const path = this.buildSwapPath(weth);
		if (path[path.length - 1].toLowerCase() !== targetToken.toLowerCase()) {
			path.push(targetToken);
		}
		return path;
	}

	/** Build a fee payment path: native→[ZERO, usdt], usdt→[usdt], erc20→[token, usdt]. */
	static buildFeePath(paymentAddress: string, usdtAddress: string): string[] {
		if (paymentAddress === ethers.ZeroAddress) return [ethers.ZeroAddress, usdtAddress];
		if (paymentAddress.toLowerCase() === usdtAddress.toLowerCase()) return [usdtAddress];
		return [paymentAddress, usdtAddress];
	}

	// ── Quote computation ─────────────────────────────────────────

	private _computeQuote() {
		// Read all reactive inputs so Svelte tracks them
		const amt = this.amountIn;
		const inAddr = this.tokenIn;
		const outAddr = this.tokenOut;
		const decIn = this.decimalsIn;
		const decOut = this.decimalsOut;
		const inIsNative = this.tokenInIsNative;
		const outIsNative = this.tokenOutIsNative;
		const provider = this.provider;
		const routerAddr = this.tradeRouterAddress;

		if (this._quoteTimeout) clearTimeout(this._quoteTimeout);

		if (!amt || !inAddr || !outAddr || parseFloat(amt) <= 0) {
			this.route = null;
			this.amountOut = '';
			this.noLiquidity = false;
			this.loading = false;
			return;
		}

		// ── Instant quote from TradeLens cache ──
		let hasInstant = false;
		const weth = getWeth();

		try {
			if (isCacheLoaded()) {
				const sanitized = parseFloat(amt).toFixed(decIn);
				const parsedIn = ethers.parseUnits(sanitized, decIn);
				const resolvedIn = inIsNative ? weth : inAddr;
				const resolvedOut = outIsNative ? weth : outAddr;

				const best = findBestRoute(resolvedIn, resolvedOut, parsedIn);
				if (best && best.amountOut > 0n) {
					this.amountOut = ethers.formatUnits(best.amountOut, decOut);
					this.route = best;
					this.noLiquidity = false;
					hasInstant = true;
				} else {
					this.route = null;
				}
			}
		} catch {
			// Cache miss or parse error — fall through to on-chain
		}

		// ── On-chain validation (debounced) ──
		if (!provider || !routerAddr) {
			if (!hasInstant) {
				this.amountOut = '';
				this.noLiquidity = true;
			}
			this.loading = false;
			return;
		}

		if (!hasInstant) this.loading = true;

		this._quoteTimeout = setTimeout(async () => {
			try {
				const router = new ethers.Contract(routerAddr, TRADE_ROUTER_ABI, provider);
				const w = weth || (await router.weth());
				const resolvedIn = inIsNative ? w : inAddr;
				const resolvedOut = outIsNative ? w : outAddr;
				const sanitized = parseFloat(amt).toFixed(decIn);
				const parsedIn = ethers.parseUnits(sanitized, decIn);

				const quotePath = this.route?.path?.length
					? this.route.path
					: resolvedIn !== w && resolvedOut !== w
						? [resolvedIn, w, resolvedOut]
						: [resolvedIn, resolvedOut];

				const out = await router.getAmountOut(quotePath, parsedIn);
				this.amountOut = ethers.formatUnits(out, decOut);
				this.noLiquidity = false;
			} catch {
				if (!hasInstant) {
					this.amountOut = '';
					this.noLiquidity = true;
				}
			} finally {
				this.loading = false;
			}
		}, hasInstant ? 500 : 150);
	}

	// ── Tax simulation ────────────────────────────────────────────

	private _computeTax() {
		// Track only token addresses + provider — NOT amount (avoid re-sim on keystroke)
		const inAddr = this.tokenIn;
		const outAddr = this.tokenOut;
		const inIsNative = this.tokenInIsNative;
		const outIsNative = this.tokenOutIsNative;
		const provider = this.provider;
		const dexRouter = this.dexRouterAddress;
		const chainId = this.chainId;
		const user = this.userAddress;

		if (!provider || !dexRouter || !chainId) return;

		// Simulate tax for tokenIn (if non-native and changed)
		const resolvedIn = inIsNative ? '' : inAddr;
		if (resolvedIn && resolvedIn !== this._lastTaxIn) {
			this._lastTaxIn = resolvedIn;
			this._simulateTax(resolvedIn, 'in', provider, dexRouter, chainId, user);
		} else if (!resolvedIn) {
			this.taxIn = null;
			this._lastTaxIn = '';
		}

		// Simulate tax for tokenOut (if non-native and changed)
		const resolvedOut = outIsNative ? '' : outAddr;
		if (resolvedOut && resolvedOut !== this._lastTaxOut) {
			this._lastTaxOut = resolvedOut;
			this._simulateTax(resolvedOut, 'out', provider, dexRouter, chainId, user);
		} else if (!resolvedOut) {
			this.taxOut = null;
			this._lastTaxOut = '';
		}
	}

	private async _simulateTax(
		tokenAddr: string,
		side: 'in' | 'out',
		provider: ethers.Provider,
		dexRouter: string,
		chainId: number,
		user: string,
	) {
		this.taxLoading = true;
		try {
			const weth = getWeth();
			const allTokens = [tokenAddr];
			if (weth && !allTokens.includes(weth)) allTokens.push(weth);

			const bases = [this.usdtAddress, this.usdcAddress].filter(Boolean);
			const users = user && user !== ethers.ZeroAddress ? [user] : [];

			const result = await queryTradeLens(
				provider as any,
				dexRouter,
				allTokens,
				tokenAddr,
				ethers.parseEther('0.001'),
				users.length ? users : ethers.ZeroAddress,
				chainId,
				bases.length ? bases : undefined,
			);

			if (side === 'in') {
				this.taxIn = result.taxInfo;
			} else {
				this.taxOut = result.taxInfo;
			}
		} catch (e) {
			console.warn(`SwapRouter: tax sim failed for ${side}:`, (e as any)?.message?.slice(0, 200));
			if (side === 'in') this.taxIn = null;
			else this.taxOut = null;
		} finally {
			this.taxLoading = false;
		}
	}

	/** Cleanup — call in onDestroy if needed. */
	destroy() {
		if (this._quoteTimeout) clearTimeout(this._quoteTimeout);
	}
}
