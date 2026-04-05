/**
 * Wrapper around fetch that:
 * 1. Adds the connected wallet address header (wallet switch detection)
 * 2. Auto-signs on 401 (creates session cookie) and retries
 */
import { ethers } from 'ethers';

let _getWalletAddress: (() => string | null) | null = null;
let _getSigner: (() => ethers.Signer | null) | null = null;
let _signing = false;

/** Call once from root layout to provide wallet getter and signer getter */
export function initApiFetch(getAddress: () => string | null, getSigner?: () => ethers.Signer | null) {
	_getWalletAddress = getAddress;
	_getSigner = getSigner || null;
}

/** Fetch with wallet header + auto-sign on 401 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const wallet = _getWalletAddress?.() || null;
	const headers = new Headers(init?.headers);

	if (wallet) {
		headers.set('x-wallet-address', wallet.toLowerCase());
	}

	const res = await fetch(input, { ...init, headers });

	// If 401 and we have a signer, auto-sign to create session then retry
	if (res.status === 401 && _getSigner && !_signing) {
		const signer = _getSigner();
		if (signer) {
			const signed = await autoSign(signer);
			if (signed) {
				// Retry the original request with the new session cookie
				return fetch(input, { ...init, headers });
			}
		}
	}

	return res;
}

/** Sign a message to create a session cookie */
async function autoSign(signer: ethers.Signer): Promise<boolean> {
	if (_signing) return false;
	_signing = true;
	try {
		const address = await signer.getAddress();
		const timestamp = Date.now();
		const origin = typeof window !== 'undefined' ? window.location.origin : '';
		const message = `TokenKrafter Auth\nAddress: ${address}\nOrigin: ${origin}\nTimestamp: ${timestamp}`;
		const signature = await signer.signMessage(message);

		// Send to auth endpoint — hook creates session cookie from signature
		const res = await fetch('/api/auth', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-wallet-address': address.toLowerCase()
			},
			body: JSON.stringify({ signature, signed_message: message })
		});

		return res.ok;
	} catch {
		return false;
	} finally {
		_signing = false;
	}
}
