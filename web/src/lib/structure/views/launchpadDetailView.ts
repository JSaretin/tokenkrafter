// ═══════════════════════════════════════════════════════════════════════════
// Pure view-model helpers for the launchpad detail page
// (routes/launchpad/[chain]/[address]/+page.svelte).
//
// All functions here are pure: same inputs → same outputs, no side effects.
// They collapse the fallback-chain noise and grouped display derivations that
// used to live as ~15 separate `$derived` blocks on the parent page.
//
// Keep state/effects/contract calls in the page component; these helpers
// only shape already-loaded data for the template.
// ═══════════════════════════════════════════════════════════════════════════

import { ethers } from 'ethers';
import { getKnownLogo } from '$lib/tokenLogo';
import type { LaunchInfo, BuyPreview } from '$lib/launchpad';
import { progressPercent } from '$lib/launchpad';
import type { SupportedNetwork } from '$lib/structure';
import type { PickerToken } from '$lib/TokenPickerModal.svelte';

// ───────────────────────────────────────────────────────────────────────────
// Launch display view
// ───────────────────────────────────────────────────────────────────────────

export interface LaunchDisplayView {
	/** 0..100 — total USDT raised / hardCap. */
	progress: number;
	/** 0..100 — softCap as % of hardCap (fill-threshold marker). */
	softCapPct: number;
	/** 0..100 — tokensSold / tokensForCurve. */
	tokenProgress: number;
}

export function toLaunchDisplayView(launch: LaunchInfo | null): LaunchDisplayView {
	if (!launch) return { progress: 0, softCapPct: 0, tokenProgress: 0 };
	return {
		progress: progressPercent(launch.totalBaseRaised, launch.hardCap),
		softCapPct:
			launch.hardCap > 0n
				? Math.min(100, Number((launch.softCap * 100n) / launch.hardCap))
				: 0,
		tokenProgress:
			launch.tokensForCurve > 0n
				? Math.min(100, Number((launch.tokensSold * 100n) / launch.tokensForCurve))
				: 0,
	};
}

// ───────────────────────────────────────────────────────────────────────────
// Buy-limits / user position view
// ───────────────────────────────────────────────────────────────────────────

export interface BuyLimitsView {
	/** -1n = no per-wallet limit. 0n = user has hit the cap. Otherwise USDT wei
	 *  remaining inside the cap. */
	remainingBuyUsdt: bigint;
	/** Max-buy cap as % of hardCap (0 = no limit). */
	maxBuyPct: number;
	/** True when the user can't make another valid buy — remaining < minBuy. */
	atMaxBuy: boolean;
	/** 0..100 — how full the user's personal allocation is. */
	allocationPct: number;
	/** True when current buyAmount + basePaid would blow past the cap. */
	exceedsMaxBuy: boolean;
	/** True when current buyAmount is positive but under minBuyUsdt. */
	belowMinBuy: boolean;
	/** Pre-formatted minBuy label (e.g. "10") or '' when no min. */
	minBuyLabel: string;
}

export function toBuyLimitsView(args: {
	launch: LaunchInfo | null;
	preview: BuyPreview | null;
	buyAmount: string;
	userBasePaid: bigint;
	maxBuyPerWallet: bigint;
	minBuyUsdt: bigint;
	usdtDecimals: number;
}): BuyLimitsView {
	const { launch, preview, buyAmount, userBasePaid, maxBuyPerWallet, minBuyUsdt, usdtDecimals } =
		args;

	const remainingBuyUsdt =
		maxBuyPerWallet === 0n
			? -1n
			: maxBuyPerWallet > userBasePaid
				? maxBuyPerWallet - userBasePaid
				: 0n;

	const maxBuyPct =
		!launch || launch.hardCap === 0n || maxBuyPerWallet === 0n
			? 0
			: Number((maxBuyPerWallet * 10000n) / launch.hardCap) / 100;

	// Treat as maxed out when remaining < minBuy — no valid purchase is possible.
	const atMaxBuy =
		maxBuyPerWallet > 0n &&
		(remainingBuyUsdt === 0n ||
			(minBuyUsdt > 0n && remainingBuyUsdt > 0n && remainingBuyUsdt < minBuyUsdt));

	const allocationPct =
		maxBuyPerWallet === 0n
			? 0
			: atMaxBuy
				? 100
				: Math.min(100, Number((userBasePaid * 10000n) / maxBuyPerWallet) / 100);

	// exceedsMaxBuy: would the pending buy push basePaid over the cap?
	let exceedsMaxBuy = false;
	if (preview && maxBuyPerWallet !== 0n) {
		const buyUsdt = buyAmount
			? BigInt(Math.floor(parseFloat(String(buyAmount)) * 10 ** usdtDecimals))
			: 0n;
		exceedsMaxBuy = userBasePaid + buyUsdt > maxBuyPerWallet;
	}

	// belowMinBuy: positive amount under minBuyUsdt?
	let belowMinBuy = false;
	if (minBuyUsdt !== 0n && buyAmount && parseFloat(String(buyAmount)) > 0) {
		const buyUsdtWei = BigInt(Math.floor(parseFloat(String(buyAmount)) * 10 ** usdtDecimals));
		belowMinBuy = buyUsdtWei < minBuyUsdt;
	}

	const minBuyLabel =
		minBuyUsdt === 0n ? '' : ethers.formatUnits(minBuyUsdt, usdtDecimals).replace(/\.?0+$/, '');

	return {
		remainingBuyUsdt,
		maxBuyPct,
		atMaxBuy,
		allocationPct,
		exceedsMaxBuy,
		belowMinBuy,
		minBuyLabel,
	};
}

// ───────────────────────────────────────────────────────────────────────────
// Payment-method view
// ───────────────────────────────────────────────────────────────────────────

export type PaymentMethod = 'usdt' | 'usdc' | 'native' | 'custom';

export interface PaymentView {
	/** Uppercased symbol shown next to the pay amount (e.g. "USDT", "BNB"). */
	paySymbol: string;
	/** Full user-facing label for toasts / modals (e.g. "USDT", "USDC", "BNB"). */
	paymentLabel: string;
	/** Full token list for the picker modal. */
	payTokens: PickerToken[];
}

export function toPaymentView(args: {
	network: SupportedNetwork | null;
	buyPaymentMethod: PaymentMethod;
	customPayToken: PickerToken | null;
	usdtDecimals: number;
}): PaymentView {
	const { network, buyPaymentMethod, customPayToken, usdtDecimals } = args;

	const paySymbol = (() => {
		if (buyPaymentMethod === 'native') return network?.native_coin || 'BNB';
		if (buyPaymentMethod === 'custom' && customPayToken) return customPayToken.symbol;
		return buyPaymentMethod.toUpperCase();
	})();

	const paymentLabel = (() => {
		if (buyPaymentMethod === 'native') return network?.native_coin ?? 'BNB';
		if (buyPaymentMethod === 'custom' && customPayToken) return customPayToken.symbol;
		if (buyPaymentMethod === 'usdt') return 'USDT';
		return 'USDC';
	})();

	const payTokens: PickerToken[] = (() => {
		if (!network) return [];
		const nc = network.native_coin;
		const list: PickerToken[] = [
			{
				address: network.usdt_address,
				symbol: 'USDT',
				name: 'Tether USD',
				decimals: usdtDecimals,
				logoUrl: getKnownLogo('USDT'),
			},
		];
		if (network.usdc_address) {
			list.push({
				address: network.usdc_address,
				symbol: 'USDC',
				name: 'USD Coin',
				decimals: 18,
				logoUrl: getKnownLogo('USDC'),
			});
		}
		list.push({
			address: ethers.ZeroAddress,
			symbol: nc,
			name: `${nc} (auto-converted)`,
			decimals: 18,
			isNative: true,
			logoUrl: getKnownLogo(nc),
		});
		const wrappedNative = new Set(['WBNB', 'WETH', 'WMATIC', 'WAVAX']);
		for (const b of network.default_bases ?? []) {
			if (!b.address || list.find((t) => t.address.toLowerCase() === b.address.toLowerCase()))
				continue;
			if (wrappedNative.has(b.symbol.toUpperCase())) continue;
			list.push({
				address: b.address,
				symbol: b.symbol,
				name: b.name || b.symbol,
				decimals: 18,
				logoUrl: getKnownLogo(b.symbol),
			});
		}
		return list;
	})();

	return { paySymbol, paymentLabel, payTokens };
}

// ───────────────────────────────────────────────────────────────────────────
// Countdown view
// ───────────────────────────────────────────────────────────────────────────

export interface CountdownParts {
	days: number;
	hours: number;
	minutes: number;
	seconds: number;
	ended: boolean;
}

export interface CountdownView {
	/** True iff the launch has a future startTimestamp that hasn't arrived. */
	isScheduled: boolean;
	/** Null when launch is null — matches the previous template condition. */
	countdown: CountdownParts | null;
}

export function toCountdownView(launch: LaunchInfo | null, nowMs: number): CountdownView {
	if (!launch) return { isScheduled: false, countdown: null };

	const isScheduled = launch.startTimestamp > 0n && Number(launch.startTimestamp) * 1000 > nowMs;
	const targetMs = isScheduled ? Number(launch.startTimestamp) * 1000 : Number(launch.deadline) * 1000;
	const diff = targetMs - nowMs;
	if (diff <= 0) {
		return { isScheduled, countdown: { days: 0, hours: 0, minutes: 0, seconds: 0, ended: true } };
	}
	return {
		isScheduled,
		countdown: {
			days: Math.floor(diff / 86400000),
			hours: Math.floor((diff % 86400000) / 3600000),
			minutes: Math.floor((diff % 3600000) / 60000),
			seconds: Math.floor((diff % 60000) / 1000),
			ended: false,
		},
	};
}

// ───────────────────────────────────────────────────────────────────────────
// Sweep / creator-reclaim view (Refunding state)
// ───────────────────────────────────────────────────────────────────────────

export interface SweepView {
	sweepWindowOpen: boolean;
	isPlatformWallet: boolean;
	sweepAvailable: boolean;
}

export function toSweepView(args: {
	launch: LaunchInfo | null;
	userAddress: string | null;
	platformWalletAddress: string;
	refundStartTimestamp: bigint;
	strandedSweepDelay: bigint;
	strandedUsdtBalance: bigint;
	nowMs: number;
}): SweepView {
	const {
		launch,
		userAddress,
		platformWalletAddress,
		refundStartTimestamp,
		strandedSweepDelay,
		strandedUsdtBalance,
		nowMs,
	} = args;

	const sweepWindowOpen =
		!!launch &&
		launch.state === 3 &&
		refundStartTimestamp !== 0n &&
		strandedSweepDelay !== 0n &&
		BigInt(Math.floor(nowMs / 1000)) >= refundStartTimestamp + strandedSweepDelay;

	const isPlatformWallet =
		!!userAddress &&
		!!platformWalletAddress &&
		userAddress.toLowerCase() === platformWalletAddress.toLowerCase();

	const sweepAvailable = sweepWindowOpen && isPlatformWallet && strandedUsdtBalance > 0n;

	return { sweepWindowOpen, isPlatformWallet, sweepAvailable };
}
