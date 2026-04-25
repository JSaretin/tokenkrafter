/**
 * Referral capture + persistence.
 *
 * When a user lands on any TokenKrafter URL with `?ref=0xabc…` we
 * stick that address into localStorage. Subsequent buys / trades pass
 * it to the on-chain `Affiliate` contract via the existing
 * `buyWithRef(...)` overload — the contract pays the referrer a
 * configurable share (default 25%) of the platform fee.
 *
 * Stickiness: once captured, a referrer survives navigation and
 * tab-close. Self-referral and zero address are rejected. The
 * Affiliate contract additionally enforces stickiness server-side
 * (a user with a recorded referrer can't rotate to a new one).
 */
import { ethers } from 'ethers';

const STORAGE_KEY = 'referral_addr';

/** Capture `?ref=...` from the current URL into localStorage if valid.
 *  Safe to call repeatedly — only writes when a fresh, well-formed
 *  address appears AND the user hasn't already captured one (sticky). */
export function captureReferralFromUrl(currentUrl?: URL): void {
	if (typeof window === 'undefined') return;
	try {
		const url = currentUrl ?? new URL(window.location.href);
		const ref = url.searchParams.get('ref');
		if (!ref) return;
		if (!ethers.isAddress(ref)) return;
		if (ref.toLowerCase() === ethers.ZeroAddress.toLowerCase()) return;
		const existing = localStorage.getItem(STORAGE_KEY);
		if (existing && ethers.isAddress(existing)) return; // sticky
		localStorage.setItem(STORAGE_KEY, ref.toLowerCase());
	} catch {}
}

/** Returns the captured referrer address or null. Filters out
 *  self-referral so a user can't game it by refreshing their own
 *  link in their own session. */
export function getReferral(userAddress?: string | null): string | null {
	if (typeof window === 'undefined') return null;
	try {
		const ref = localStorage.getItem(STORAGE_KEY);
		if (!ref || !ethers.isAddress(ref)) return null;
		if (userAddress && ref.toLowerCase() === userAddress.toLowerCase()) return null;
		return ref;
	} catch {
		return null;
	}
}

/** Resolve the ref to pass into a contract call. Falls back to
 *  ZeroAddress when no captured ref or the user is referring
 *  themselves. */
export function refOrZero(userAddress?: string | null): string {
	return getReferral(userAddress) ?? ethers.ZeroAddress;
}

export function clearReferral(): void {
	if (typeof window === 'undefined') return;
	try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

/** Build a shareable URL with the user as the referrer. */
export function buildReferralUrl(baseUrl: string, userAddress: string): string {
	if (!ethers.isAddress(userAddress)) return baseUrl;
	try {
		const u = new URL(baseUrl, typeof window !== 'undefined' ? window.location.origin : 'https://tokenkrafter.com');
		u.searchParams.set('ref', userAddress.toLowerCase());
		return u.toString();
	} catch {
		return baseUrl;
	}
}
