/**
 * Frontend HTTP client for the on-ramp endpoints.
 * Throws Error with the server's message on non-2xx; caller catches
 * and surfaces to the user.
 */
import type { BankDetails, OnrampIntent, OnrampQuote, OnrampStatusView } from './types';

async function asJson<T>(res: Response): Promise<T> {
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(body?.message || body?.error || `Request failed (${res.status})`);
	}
	return body as T;
}

export async function quoteOnramp(
	ngnAmountWhole: number,
	chainId = 56,
	receiver?: string,
): Promise<OnrampQuote> {
	return asJson<OnrampQuote>(
		await fetch('/api/onramp/quote', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				ngn_amount_kobo: Math.round(ngnAmountWhole * 100),
				chain_id: chainId,
				receiver,
			}),
		}),
	);
}

export async function submitOnrampIntent(
	intent: OnrampIntent,
	signature: string,
): Promise<{ reference: string; bank_details: BankDetails }> {
	return asJson(
		await fetch('/api/onramp/intent', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ intent, signature }),
		}),
	);
}

export async function getOnrampStatus(reference: string): Promise<OnrampStatusView> {
	return asJson<OnrampStatusView>(await fetch(`/api/onramp/intent/${reference}`));
}

export async function cancelOnrampIntent(reference: string): Promise<{ ok: true }> {
	return asJson(await fetch(`/api/onramp/intent/${reference}`, { method: 'DELETE' }));
}
