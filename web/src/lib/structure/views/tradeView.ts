import { ethers } from 'ethers';
import type { SupportedNetwork } from '$lib/structure';
import type { TaxInfo } from '$lib/tradeLens';
import { getUsdValue, getWeth } from '$lib/tradeLens';

// ════════════════════════════════════════════════════════════════════════════
//  View types — pure display objects derived from trade page state
// ════════════════════════════════════════════════════════════════════════════

/** Per-slot token display snapshot (tokenIn or tokenOut side).
 *  Groups all display-only fields the TokenInput + review panels need,
 *  collapsing a dozen fallback-chain `$derived`s into one object. */
export interface TokenSlotView {
	addr: string;
	symbol: string;
	name: string;
	decimals: number;
	balance: bigint;
	isNative: boolean;
	isPlatform: boolean;
	hasTax: boolean;
	taxBuy: number;
	taxSell: number;
	taxInfo: TaxInfo | null;
	logo: string;
	loading: boolean;
}

/** Input object for `toTokenSlotView` — mirrors the raw `$state` variables
 *  on the parent, plus the platform-addr set used for honeypot suppression. */
export interface TokenSlotRaw {
	addr: string;
	symbol: string;
	name: string;
	decimals: number;
	balance: bigint;
	isNative: boolean;
	hasTax: boolean;
	taxBuy: number;
	taxSell: number;
	taxInfo: TaxInfo | null;
	logo: string;
	loading: boolean;
}

export function toTokenSlotView(raw: TokenSlotRaw, platformAddrs: Set<string>): TokenSlotView {
	return {
		addr: raw.addr,
		symbol: raw.symbol,
		name: raw.name,
		decimals: raw.decimals,
		balance: raw.balance,
		isNative: raw.isNative,
		isPlatform: !!raw.addr && platformAddrs.has(raw.addr.toLowerCase()),
		hasTax: raw.hasTax,
		taxBuy: raw.taxBuy,
		taxSell: raw.taxSell,
		taxInfo: raw.taxInfo,
		logo: raw.logo,
		loading: raw.loading,
	};
}

// ────────────────────────────────────────────────────────────────────────────

/** All the display strings derived from the input/output amounts, token metadata,
 *  slippage, and TradeLens price cache. Covers swap-mode + bank-mode formats. */
export interface TradeAmountsView {
	/** Effective tax in bps (transfer + sell + buy). */
	effectiveTax: number;
	/** Raw output scaled by `(1 - effectiveTax)` — still a raw numeric string. */
	postTaxAmountOut: string;
	/** Formatted (`formatAmount`) version of the post-tax output. */
	displayAmountOut: string;
	/** USD value of the input — e.g. "≈$12.34 USD" or ''. */
	usdValueIn: string;
	/** USD value of the output after tax — e.g. "≈$12.34 USD" or ''. */
	usdValueOut: string;
	/** Execution rate (out per 1 in) or '' when no quote / no liquidity. */
	rate: string;
	/** Pre-trade spot-rate hint ("1 BNB ≈ 600 USDT"), shown when `rate` is empty. */
	spotRate: string;
	/** Minimum received after slippage, formatted with `formatAmount`. */
	minReceived: string;
	/** USD value of `minReceived` as a bare number string e.g. "12.34", or ''. */
	minUsd: string;
	/** Slippage as a percentage string e.g. "0.5". */
	slippagePct: string;
	/** Fiat equivalent line for bank mode, e.g. "NGN 12,345" or ''. */
	fiatEquivalent: string;
}

/** Input bundle for `toTradeAmountsView`. Mirrors the raw state variables on
 *  the parent without pulling any I/O or effects. */
export interface TradeAmountsRaw {
	// Amounts
	amountIn: string;
	amountOut: string;
	noLiquidity: boolean;
	slippageBps: number;
	outputMode: 'token' | 'bank';
	// Bank-mode payout preview (USDT)
	previewNet: bigint;
	usdtDecimals: number;
	ngnRate: number;
	// Token slots (symbol/decimals/isNative/tax/...)
	tokenIn: TokenSlotView;
	tokenOut: TokenSlotView;
	// Price cache state
	pricesLoaded: boolean;
	wethAddr: string;
	// Selected network (for USDT address lookup)
	network: SupportedNetwork | undefined;
}

const STABLECOINS = ['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD'];

/** Format token amount for display — stablecoins get 2dp, others 4–6dp. */
export function formatAmount(value: string, _decimals: number, symbol: string): string {
	if (!value) return '';
	const num = parseFloat(value);
	if (isNaN(num)) return value;
	const isStable = STABLECOINS.includes(symbol.toUpperCase());
	if (isStable) return num.toFixed(2);
	if (num >= 1000) return num.toFixed(2);
	if (num >= 1) return num.toFixed(4);
	return num.toFixed(6);
}

export function toTradeAmountsView(raw: TradeAmountsRaw): TradeAmountsView {
	const { amountIn, amountOut, noLiquidity, slippageBps, outputMode, previewNet, usdtDecimals, ngnRate, tokenIn, tokenOut, pricesLoaded, wethAddr, network } = raw;

	// ── Effective tax (bps) ──────────────────────────────────────
	const transfer = tokenIn.taxInfo?.transferTaxBps || 0;
	const sell = tokenIn.hasTax ? tokenIn.taxSell : 0;
	const buy = tokenOut.hasTax ? tokenOut.taxBuy : 0;
	const effectiveTax = transfer + sell + buy;

	// ── Post-tax raw output ──────────────────────────────────────
	let postTaxAmountOut = '';
	if (amountOut) {
		if (effectiveTax <= 0) postTaxAmountOut = amountOut;
		else {
			const r = parseFloat(amountOut);
			postTaxAmountOut = String(r * (1 - effectiveTax / 10000));
		}
	}

	const displayAmountOut = formatAmount(postTaxAmountOut || amountOut, tokenOut.decimals, tokenOut.symbol);

	// ── USD value IN ─────────────────────────────────────────────
	const usdValueIn = computeUsdValueIn(amountIn, tokenIn, tokenOut, displayAmountOut, pricesLoaded, wethAddr, network);

	// ── USD value OUT ────────────────────────────────────────────
	const usdValueOut = computeUsdValueOut(postTaxAmountOut || amountOut, amountIn, tokenIn, tokenOut, usdValueIn, pricesLoaded, wethAddr, network);

	// ── Rate (execution) ─────────────────────────────────────────
	let rate = '';
	if (amountIn && amountOut && parseFloat(amountIn) > 0 && !noLiquidity) {
		const r = parseFloat(amountOut) / parseFloat(amountIn);
		rate = formatAmount(String(r), tokenOut.decimals, tokenOut.symbol);
	}

	// ── Spot rate (pre-trade hint) ───────────────────────────────
	const spotRate = rate
		? ''
		: computeSpotRate(tokenIn, tokenOut, pricesLoaded, wethAddr, network);

	// ── Min received ─────────────────────────────────────────────
	let minReceived = '';
	if (postTaxAmountOut && !noLiquidity) {
		const out = parseFloat(postTaxAmountOut);
		const m = out * (1 - slippageBps / 10000);
		minReceived = formatAmount(String(m), tokenOut.decimals, tokenOut.symbol);
	}

	// ── Min received in USD ──────────────────────────────────────
	const minUsd = (usdValueOut && displayAmountOut && parseFloat(displayAmountOut) > 0 && minReceived)
		? (parseFloat(usdValueOut.replace(/[^0-9.]/g, '')) * parseFloat(minReceived) / parseFloat(displayAmountOut)).toFixed(2)
		: '';

	// ── Slippage % ───────────────────────────────────────────────
	const slippagePct = (slippageBps / 100).toFixed(
		slippageBps % 100 === 0 ? 0 : slippageBps % 10 === 0 ? 1 : 2
	);

	// ── Fiat equivalent (bank mode) ──────────────────────────────
	let fiatEquivalent = '';
	if (amountIn && ngnRate > 0 && outputMode === 'bank' && previewNet > 0n) {
		const usdtVal = parseFloat(ethers.formatUnits(previewNet, usdtDecimals));
		const ngn = usdtVal * ngnRate;
		if (ngn > 0) {
			fiatEquivalent = `NGN ${ngn.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
		}
	}

	return {
		effectiveTax,
		postTaxAmountOut,
		displayAmountOut,
		usdValueIn,
		usdValueOut,
		rate,
		spotRate,
		minReceived,
		minUsd,
		slippagePct,
		fiatEquivalent,
	};
}

// ── USD value helpers (internal to tradeAmountsView) ────────────

function computeUsdValueIn(
	amountIn: string,
	tokenIn: TokenSlotView,
	tokenOut: TokenSlotView,
	displayAmountOut: string,
	pricesLoaded: boolean,
	wethAddr: string,
	network: SupportedNetwork | undefined,
): string {
	if (!amountIn || !tokenIn.addr || parseFloat(amountIn) <= 0) return '';
	try {
		// If input IS a stablecoin, USD = amount
		if (STABLECOINS.includes(tokenIn.symbol.toUpperCase())) {
			const val = parseFloat(amountIn);
			return `≈$${val.toFixed(2)} USD`;
		}
		// Otherwise, use the output value (if output is stablecoin, that's the USD value)
		if (STABLECOINS.includes(tokenOut.symbol.toUpperCase()) && displayAmountOut) {
			const val = parseFloat(displayAmountOut);
			if (val > 0) return `≈$${val.toFixed(2)} USD`;
		}
		// Fallback: use reserves spot price
		if (!network?.usdt_address || !pricesLoaded) return '';
		const parsed = ethers.parseUnits(parseFloat(amountIn).toFixed(tokenIn.decimals), tokenIn.decimals);
		const addr = tokenIn.isNative ? (wethAddr || getWeth()) : tokenIn.addr;
		const usd = getUsdValue(addr, parsed, tokenIn.decimals, network.usdt_address);
		if (usd === null || usd === 0) return '';
		return `≈$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)} USD`;
	} catch {
		return '';
	}
}

function computeUsdValueOut(
	raw: string,
	amountIn: string,
	tokenIn: TokenSlotView,
	tokenOut: TokenSlotView,
	usdValueIn: string,
	pricesLoaded: boolean,
	wethAddr: string,
	network: SupportedNetwork | undefined,
): string {
	if (!raw || !tokenOut.addr || parseFloat(raw) <= 0) return '';
	try {
		// If output IS a stablecoin, USD = the post-tax amount directly
		if (STABLECOINS.includes(tokenOut.symbol.toUpperCase())) {
			const val = parseFloat(raw);
			return `≈$${val.toFixed(2)} USD`;
		}
		// Otherwise, derive USD from the input value minus tax
		if (STABLECOINS.includes(tokenIn.symbol.toUpperCase()) && amountIn) {
			const inputVal = parseFloat(amountIn);
			const buyTax = tokenOut.taxInfo?.buyTaxBps || tokenOut.taxBuy || 0;
			const sellTax = tokenIn.taxInfo?.sellTaxBps || tokenIn.taxSell || 0;
			const totalTax = buyTax + sellTax;
			const afterTax = totalTax > 0 ? inputVal * (1 - totalTax / 10000) : inputVal;
			if (afterTax > 0) return `≈$${afterTax.toFixed(2)} USD`;
		}
		// Fallback: use reserves spot price
		if (!network?.usdt_address || !pricesLoaded) return '';
		try {
			const rawNum = parseFloat(raw);
			const decimals = tokenOut.decimals || 18;
			const truncated = rawNum.toFixed(Math.min(decimals, 8));
			const parsed = ethers.parseUnits(truncated, decimals);
			const addr = tokenOut.isNative ? (wethAddr || getWeth()) : tokenOut.addr;
			const usd = getUsdValue(addr, parsed, decimals, network.usdt_address);
			if (usd === null || usd === 0 || !isFinite(usd)) return '';
			// Sanity: if input is worth $X, output shouldn't be worth 100x that
			const inputUsd = parseFloat(usdValueIn?.replace(/[^0-9.]/g, '') || '0');
			if (inputUsd > 0 && usd > inputUsd * 10) return `≈$${inputUsd.toFixed(2)} USD`;
			return `≈$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)} USD`;
		} catch {
			return '';
		}
	} catch {
		return '';
	}
}

function computeSpotRate(
	tokenIn: TokenSlotView,
	tokenOut: TokenSlotView,
	pricesLoaded: boolean,
	wethAddr: string,
	network: SupportedNetwork | undefined,
): string {
	if (!tokenIn.symbol || !tokenOut.symbol || !pricesLoaded || !network?.usdt_address) return '';
	try {
		const inAddr = tokenIn.isNative ? (wethAddr || getWeth()) : tokenIn.addr;
		const outAddr = tokenOut.isNative ? (wethAddr || getWeth()) : tokenOut.addr;
		if (!inAddr || !outAddr) return '';
		const oneUnit = ethers.parseUnits('1', tokenIn.decimals);
		const inUsd = getUsdValue(inAddr, oneUnit, tokenIn.decimals, network.usdt_address);
		const outUsd = getUsdValue(outAddr, ethers.parseUnits('1', tokenOut.decimals), tokenOut.decimals, network.usdt_address);
		if (!inUsd || !outUsd || outUsd === 0) return '';
		const r = inUsd / outUsd;
		return `1 ${tokenIn.symbol} ≈ ${r >= 1 ? r.toFixed(2) : r.toFixed(6)} ${tokenOut.symbol}`;
	} catch {
		return '';
	}
}

// ────────────────────────────────────────────────────────────────────────────

/** Submit-button state — label, variant, disabled flag + the individual
 *  gating flags we also expose for template-side conditionals. */
export interface TradeActionView {
	hasGas: boolean;
	insufficientBalance: boolean;
	noGas: boolean;
	belowMinWithdraw: boolean;
	buttonLabel: string;
	buttonDisabled: boolean;
	buttonVariant: 'primary' | 'bank' | 'error';
	contractUrl: string;
}

/** Input bundle for `toTradeActionView`. */
export interface TradeActionRaw {
	// Wallet + transaction state
	userAddress: string | null;
	isSwapping: boolean;
	// Amounts
	amountIn: string;
	// Token slots
	tokenIn: TokenSlotView;
	tokenOut: TokenSlotView;
	// Liquidity / mode
	noLiquidity: boolean;
	outputMode: 'token' | 'bank';
	// Gas check
	nativeBalance: bigint;
	estimatedGasCost: bigint;
	// Bank-mode payout state
	previewFee: bigint;
	previewNet: bigint;
	minWithdrawUsdt: bigint;
	usdtDecimals: number;
	paymentMethod: 'bank' | 'paypal' | 'wise';
	bankResolved: boolean;
	bankAccount: string;
	bankCode: string;
	paypalEmail: string;
	wiseEmail: string;
	// Selected network
	network: SupportedNetwork | undefined;
	// i18n — translator so this stays pure + locale-aware
	t: (key: string) => string;
}

export function toTradeActionView(raw: TradeActionRaw): TradeActionView {
	const {
		userAddress, isSwapping, amountIn, tokenIn, tokenOut, noLiquidity, outputMode,
		nativeBalance, estimatedGasCost, previewFee, previewNet, minWithdrawUsdt,
		usdtDecimals, paymentMethod, bankResolved, bankAccount, bankCode,
		paypalEmail, wiseEmail, network, t,
	} = raw;

	const hasGas = nativeBalance > estimatedGasCost;

	// Insufficient balance
	let insufficientBalance = false;
	if (userAddress && tokenIn.addr && amountIn && parseFloat(amountIn) > 0) {
		if (tokenIn.balance === 0n) {
			insufficientBalance = true;
		} else {
			try {
				const sanitized = parseFloat(amountIn).toFixed(tokenIn.decimals);
				const needed = ethers.parseUnits(sanitized, tokenIn.decimals);
				insufficientBalance = needed > tokenIn.balance;
			} catch {
				insufficientBalance = false;
			}
		}
	}

	const noGas = !!userAddress && !tokenIn.isNative && !hasGas && !!tokenIn.addr && !!amountIn;

	// Off-ramp floor: gross USDT output must clear minWithdrawUsdt
	const belowMinWithdraw =
		outputMode === 'bank' &&
		minWithdrawUsdt > 0n &&
		(previewFee + previewNet) > 0n &&
		(previewFee + previewNet) < minWithdrawUsdt;

	// Button label
	let buttonLabel: string;
	if (isSwapping) buttonLabel = t('trade.processing');
	else if (!tokenIn.addr) buttonLabel = t('trade.selectToken');
	else if (!amountIn || parseFloat(amountIn) <= 0) buttonLabel = t('trade.enterAmount');
	else if (insufficientBalance) buttonLabel = t('trade.insufficientBalance').replace('{symbol}', tokenIn.symbol);
	else if (noGas) buttonLabel = t('trade.insufficientGas').replace('{symbol}', network?.native_coin || 'gas');
	else if (noLiquidity && outputMode === 'token') buttonLabel = t('trade.insufficientLiquidity');
	else if (outputMode === 'bank') {
		if (belowMinWithdraw) {
			const min = parseFloat(ethers.formatUnits(minWithdrawUsdt, usdtDecimals)).toFixed(2);
			buttonLabel = t('trade.minimumWithdrawal').replace('{amount}', min);
		} else if (paymentMethod === 'bank' && (!bankResolved || !bankAccount || !bankCode)) {
			buttonLabel = t('trade.verifyBank');
		} else if (paymentMethod === 'paypal' && !paypalEmail) {
			buttonLabel = t('trade.enterPaypalEmail');
		} else if (paymentMethod === 'wise' && !wiseEmail) {
			buttonLabel = t('trade.enterWiseEmail');
		} else {
			const methodLabel = paymentMethod === 'bank'
				? t('trade.bankPayment')
				: paymentMethod === 'paypal'
					? t('trade.paypalPayment')
					: t('trade.wisePayment');
			buttonLabel = `${t('common.sell')} ${tokenIn.symbol} → ${methodLabel}`;
		}
	} else if (!tokenOut.addr) {
		buttonLabel = t('trade.selectOutputToken');
	} else {
		buttonLabel = `${t('trade.swap')} ${tokenIn.symbol} → ${tokenOut.symbol}`;
	}

	// Button disabled
	const buttonDisabled =
		isSwapping ||
		!tokenIn.addr || !amountIn || parseFloat(amountIn) <= 0 ||
		insufficientBalance || noGas ||
		(outputMode === 'token' && (!tokenOut.addr || noLiquidity)) ||
		(outputMode === 'bank' && (
			belowMinWithdraw ||
			(paymentMethod === 'bank' && (!bankResolved || !bankAccount || !bankCode)) ||
			(paymentMethod === 'paypal' && !paypalEmail) ||
			(paymentMethod === 'wise' && !wiseEmail)
		));

	const buttonVariant: 'primary' | 'bank' | 'error' =
		insufficientBalance || noGas ? 'error' : outputMode === 'bank' ? 'bank' : 'primary';

	const contractUrl = network?.trade_router_address
		? `${network.explorer_url || 'https://bscscan.com'}/address/${network.trade_router_address}`
		: '';

	return {
		hasGas,
		insufficientBalance,
		noGas,
		belowMinWithdraw,
		buttonLabel,
		buttonDisabled,
		buttonVariant,
		contractUrl,
	};
}
