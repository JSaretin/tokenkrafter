// View-model helpers for /create page.
//
// These are pure functions: raw inputs in, display-ready View out.
// Each View groups cohesive derivations that the page previously
// expressed as a cluster of individual $derived declarations.
//
// Follows the lib/structure/* toXxxView(raw): View convention.

import { ethers } from 'ethers';
import type { SupportedNetwork, PaymentOption } from '$lib/structure';

// ════════════════════════════════════════════════════════════════════════════
//  URL intent view — decode the /create entry-point querystring
// ════════════════════════════════════════════════════════════════════════════

export type IntentMode = 'token' | 'launch' | 'both' | 'list';

export interface UrlIntentView {
	modeFromUrl: IntentMode | null;
	launchFromUrl: boolean;
	tokenFromUrl: string;
	chainFromUrl: string;
}

export function toUrlIntentView(params: URLSearchParams): UrlIntentView {
	const raw = params.get('mode');
	const modeFromUrl: IntentMode | null =
		raw === 'token' || raw === 'launch' || raw === 'both' || raw === 'list' ? raw : null;
	return {
		modeFromUrl,
		launchFromUrl: params.get('launch') === 'true',
		tokenFromUrl: params.get('token') || '',
		chainFromUrl: params.get('chain') || '',
	};
}

/**
 * Build the initial TokenForm data bag from URL intent + available networks.
 * Returns `undefined` when there's nothing to prefill (lets the form use its own defaults).
 */
export function toInitialFormData(
	intent: UrlIntentView,
	supportedNetworks: SupportedNetwork[],
): Record<string, unknown> | undefined {
	const data: Record<string, unknown> = {};
	if (intent.tokenFromUrl) data.existingTokenAddress = intent.tokenFromUrl;
	if (intent.chainFromUrl) {
		const net = supportedNetworks.find(
			(n) => n.symbol === intent.chainFromUrl || String(n.chain_id) === intent.chainFromUrl,
		);
		if (net) data.chainId = net.chain_id;
	}
	return Object.keys(data).length > 0 ? data : undefined;
}

// ════════════════════════════════════════════════════════════════════════════
//  Fee display view — the "pay with X" row in the review modal
// ════════════════════════════════════════════════════════════════════════════

export interface FeeDisplayView {
	/** Display-formatted amount for the selected payment token (4 dp). */
	selectedFeeFormatted: string;
	/** USD value of the creation fee (always driven off USDT, which is index 0). */
	feeUsdAmount: string;
	/** Wei-denominated amountIn quote from the router for the selected option. */
	selectedQuote: bigint;
	/** True when the selected payment token equals the network's USDT. */
	isDirectUsdt: boolean;
	/** Wei-denominated fee after slippage buffer (adds 1% for non-USDT paths). */
	selectedFeeWithSlippage: bigint;
	/** Display-formatted fee including slippage (6 dp). */
	selectedFeeDisplay: string;
}

export interface FeeDisplayInput {
	selectedPayment: PaymentOption | undefined;
	selectedFee: bigint;
	selectedPaymentIndex: number;
	feeAmounts: bigint[];
	paymentOptions: PaymentOption[];
	paymentQuotes: bigint[];
	/** The network whose USDT we compare against. May be absent before token info loads. */
	usdtAddress?: string | null;
}

export function toFeeDisplayView(input: FeeDisplayInput): FeeDisplayView {
	const { selectedPayment, selectedFee, selectedPaymentIndex, feeAmounts, paymentOptions, paymentQuotes, usdtAddress } = input;

	const selectedFeeFormatted = selectedPayment && selectedFee
		? parseFloat(ethers.formatUnits(selectedFee, selectedPayment.decimals)).toFixed(4)
		: '0';

	const feeUsdAmount = feeAmounts.length > 0 && paymentOptions.length > 0
		? parseFloat(ethers.formatUnits(feeAmounts[0], paymentOptions[0]?.decimals ?? 6)).toFixed(4)
		: '0';

	const selectedQuote = paymentQuotes[selectedPaymentIndex] ?? 0n;

	// Only treat as direct USDT when we both have a selected option and a
	// reference USDT address on the active network.
	const isDirectUsdt = Boolean(
		selectedPayment && usdtAddress && selectedPayment.address.toLowerCase() === usdtAddress.toLowerCase(),
	);

	// USDT direct: exact fee. Otherwise pad the quote by 1% to cover price drift
	// between quote time and tx landing (excess is refunded).
	const selectedFeeWithSlippage = isDirectUsdt
		? selectedFee
		: (selectedQuote > 0n ? (selectedQuote * 101n) / 100n : selectedFee);

	const selectedFeeDisplay = selectedPayment && selectedFeeWithSlippage > 0n
		? parseFloat(ethers.formatUnits(selectedFeeWithSlippage, selectedPayment.decimals)).toFixed(6)
		: selectedFeeFormatted;

	return {
		selectedFeeFormatted,
		feeUsdAmount,
		selectedQuote,
		isDirectUsdt,
		selectedFeeWithSlippage,
		selectedFeeDisplay,
	};
}

// ════════════════════════════════════════════════════════════════════════════
//  Deposit view — the "send at least X" modal when the user is short
// ════════════════════════════════════════════════════════════════════════════

export interface DepositView {
	/** Total native needed when paying in native: fee (+8% buffer) + any native LP pairs. */
	totalNativeNeeded: bigint;
	/** Wei the user must have; native uses totalNativeNeeded, erc20 re-parses the formatted fee. */
	depositNeededWei: bigint;
	/** Shortfall in wei vs. the user's current balance, clamped to 0. */
	depositShortWei: bigint;
	/** Shortfall formatted to 4 dp in the selected payment token. */
	depositShortFmt: string;
}

export interface DepositInput {
	selectedPayment: PaymentOption | undefined;
	selectedFee: bigint;
	/** Already-formatted fee (for erc20 path we re-parse this to match the display value). */
	selectedFeeFormatted: string;
	isNativePayment: boolean;
	userBalance: bigint;
	/** Listing pairs (native legs contribute additional native). */
	listingPairs: ReadonlyArray<{ base: string; amount: string }> | undefined;
}

export function toDepositView(input: DepositInput): DepositView {
	const { selectedPayment, selectedFee, selectedFeeFormatted, isNativePayment, userBalance, listingPairs } = input;

	let totalNativeNeeded = isNativePayment ? (selectedFee * 108n) / 100n : 0n;
	if (listingPairs) {
		for (const pair of listingPairs) {
			if (pair.base === 'native' && Number(pair.amount) > 0) {
				totalNativeNeeded += ethers.parseEther(String(pair.amount));
			}
		}
	}

	const dec = selectedPayment?.decimals ?? 18;
	let depositNeededWei: bigint;
	if (isNativePayment) {
		depositNeededWei = totalNativeNeeded;
	} else {
		try {
			depositNeededWei = ethers.parseUnits(String(selectedFeeFormatted || '0'), dec);
		} catch {
			depositNeededWei = 0n;
		}
		// When the user is paying the fee in an ERC20 (e.g. USDT) AND
		// listing with a same-token LP pair (e.g. USDT LP), the contract
		// will pull (fee + LP_amount) from their balance. The deposit
		// modal needs to show the combined ask, not just the fee, or
		// the user thinks they're funded after sending only the fee
		// portion and the create-and-list tx reverts on transferFrom.
		const paySym = (selectedPayment?.symbol || '').toUpperCase();
		if (paySym && listingPairs) {
			for (const pair of listingPairs) {
				if (!pair.base || pair.base === 'native') continue;
				if (pair.base.toUpperCase() !== paySym) continue;
				if (!(Number(pair.amount) > 0)) continue;
				try {
					depositNeededWei += ethers.parseUnits(String(pair.amount), dec);
				} catch {}
			}
		}
	}

	const depositShortWei = depositNeededWei > userBalance ? depositNeededWei - userBalance : 0n;
	const depositShortFmt = parseFloat(ethers.formatUnits(depositShortWei, dec)).toFixed(4);

	return { totalNativeNeeded, depositNeededWei, depositShortWei, depositShortFmt };
}

// ════════════════════════════════════════════════════════════════════════════
//  Deploy-progress stepper — labels + ordering depend on whether DEX listing is on
// ════════════════════════════════════════════════════════════════════════════

export interface DeployStep {
	key: string;
	label: string;
}

export interface DeployStepsInput {
	listingEnabled: boolean;
	/** Pass $t so the helper stays framework-agnostic. */
	t: (key: string) => string;
}

export function toDeployStepsView(input: DeployStepsInput): DeployStep[] {
	const steps: DeployStep[] = [
		{ key: 'checking-balance', label: input.t('ct.stepCheckBalance') },
		{ key: 'approving', label: input.t('ct.approvingSpend') },
		{ key: 'creating', label: input.t('ct.deployingContract') },
	];
	if (input.listingEnabled) {
		steps.push(
			{ key: 'approving-listing', label: input.t('ct.approvingDex') },
			{ key: 'adding-liquidity', label: input.t('ct.addingLiquidity') },
		);
	}
	return steps;
}
