/**
 * Wrapper around fetch that adds the connected wallet address header.
 * This lets the server invalidate sessions when the user switches wallets.
 */

let _getWalletAddress: (() => string | null) | null = null;

/** Call once from root layout to provide the wallet getter */
export function initApiFetch(getAddress: () => string | null) {
	_getWalletAddress = getAddress;
}

/** Fetch with wallet header. Drop-in replacement for fetch() on API calls. */
export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const wallet = _getWalletAddress?.() || null;
	const headers = new Headers(init?.headers);

	if (wallet) {
		headers.set('x-wallet-address', wallet.toLowerCase());
	}

	return fetch(input, { ...init, headers });
}
