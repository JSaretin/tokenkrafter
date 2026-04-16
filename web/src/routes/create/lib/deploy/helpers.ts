/**
 * Pure helpers for the token creation / deploy flow.
 *
 * Extracted from the /create page to get them out of the 2000+ line
 * component and make them independently testable. Nothing here touches
 * component state — the parent still owns all $state and orchestration.
 */

import type { SupportedNetwork, PaymentOption } from '$lib/structure';
import { ZERO_ADDRESS } from '$lib/tokenCrafter';

// ── Base coin helpers (native / USDT / USDC selection on the listing form) ──

export function getBaseTokenAddress(network: SupportedNetwork, baseCoin: string): string {
	if (baseCoin === 'native') return ZERO_ADDRESS;
	if (baseCoin === 'usdt') return network.usdt_address;
	return network.usdc_address;
}

export function getBaseDecimals(network: SupportedNetwork, baseCoin: string): number {
	if (baseCoin === 'native') return 18;
	// BSC peg-USDT/USDC use 18 decimals; everywhere else (Eth, Base, Arb, Polygon)
	// the bridged/native versions use 6.
	return network.chain_id === 56 ? 18 : 6;
}

export function getBaseSymbol(network: SupportedNetwork, baseCoin: string): string {
	if (baseCoin === 'native') return network.native_coin;
	return baseCoin.toUpperCase();
}

// ── Explorer URL builder ────────────────────────────────────────────────

export function getExplorerUrl(
	supportedNetworks: SupportedNetwork[],
	chainId: number,
	type: 'tx' | 'address',
	hash: string,
): string {
	const net = supportedNetworks.find((n) => n.chain_id === chainId);
	const base = net?.explorer_url || 'https://bscscan.com';
	return `${base}/${type}/${hash}`;
}

// ── Fee cache / matching ────────────────────────────────────────────────

/** Build a stable cache key for a token type's creation fee. */
export function feeCacheKey(
	chainId: number,
	isTaxable: boolean,
	isMintable: boolean,
	isPartner: boolean,
): string {
	const typeKey = (isPartner ? 4 : 0) | (isTaxable ? 2 : 0) | (isMintable ? 1 : 0);
	return `${chainId}-${typeKey}`;
}

/**
 * Given parallel arrays of payment-token addresses + fee amounts (as returned
 * by TokenFactory.feeFor), keep only the entries that have an actual non-zero
 * fee AND match one of the user's configured PaymentOptions. Returns a
 * trimmed pair of arrays suitable for rendering a fee dropdown.
 */
export function matchFeesToPayments(
	tokens: string[],
	fees: bigint[],
	options: PaymentOption[],
): { matchedOptions: PaymentOption[]; matchedFees: bigint[] } {
	const matchedOptions: PaymentOption[] = [];
	const matchedFees: bigint[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const addr = tokens[i].toLowerCase();
		const opt = options.find((p) => p.address.toLowerCase() === addr);
		if (opt && fees[i] > 0n) {
			matchedOptions.push(opt);
			matchedFees.push(fees[i]);
		}
	}
	return { matchedOptions, matchedFees };
}

// ── Wallet network switching ────────────────────────────────────────────

/**
 * Ask the injected wallet (window.ethereum) to switch to the given chain.
 * Returns true on success, false on failure. The caller is responsible for
 * showing a toast on failure — this helper intentionally stays silent so
 * it can be reused anywhere an `addFeedback` hook isn't in scope.
 */
export async function switchWalletNetwork(chainId: number): Promise<'ok' | 'not-added' | 'failed'> {
	const ethereum = (globalThis as any).ethereum;
	if (!ethereum) return 'failed';
	try {
		await ethereum.request({
			method: 'wallet_switchEthereumChain',
			params: [{ chainId: '0x' + chainId.toString(16) }],
		});
		return 'ok';
	} catch (e: any) {
		if (e?.code === 4902) return 'not-added';
		return 'failed';
	}
}
