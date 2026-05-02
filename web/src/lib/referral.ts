/**
 * Referral capture + persistence.
 *
 * Lifecycle:
 *   1. Visitor lands on `/?ref=<address|alias>` → captureReferralFromUrl()
 *      stores the raw value in localStorage under PENDING_KEY (sticky).
 *   2. User connects a wallet → lockReferral(addr) POSTs the pending
 *      value to /api/referred. Backend resolves the alias if needed,
 *      inserts first-write-wins, and returns the locked record. We
 *      cache that under LOCKED_KEY:<addr> for synchronous reads.
 *   3. On-chain calls read refOrZero(addr) which returns the locked
 *      cache value or ZeroAddress. Aliases are resolved server-side
 *      so this stays sync — no network on the buy hot path.
 *
 * Stickiness:
 *   - PENDING_KEY only writes when empty (first ?ref= wins).
 *   - LOCKED_KEY:<addr> is set after the backend confirms; subsequent
 *     locks for the same wallet hit the existing row and return the
 *     same referrer.
 *   - Self-referral and zero address are rejected at every layer
 *     (FE, API, DB CHECK constraint).
 */
import { ethers } from 'ethers';

const PENDING_KEY = 'referral_addr';
const LOCKED_PREFIX = 'locked_ref:';

function lockedKey(addr: string): string {
	return `${LOCKED_PREFIX}${addr.toLowerCase()}`;
}

/** Validate a free-form referral input (address or alias). Aliases are
 *  the same shape we accept server-side: lowercase letters/digits/dash/
 *  underscore, 3–20 chars. */
function isValidReferralInput(v: string): boolean {
	if (!v) return false;
	const lower = v.toLowerCase();
	if (ethers.isAddress(lower)) return lower !== ethers.ZeroAddress.toLowerCase();
	return /^[a-z0-9_-]{3,20}$/.test(lower);
}

/** Capture `?ref=...` from the current URL into localStorage. Accepts
 *  both addresses and aliases — the backend resolves aliases on lock.
 *  Sticky: only writes when no pending value exists. */
export function captureReferralFromUrl(currentUrl?: URL): void {
	if (typeof window === 'undefined') return;
	try {
		const url = currentUrl ?? new URL(window.location.href);
		const ref = url.searchParams.get('ref');
		if (!ref) return;
		const v = ref.toLowerCase();
		if (!isValidReferralInput(v)) return;
		if (localStorage.getItem(PENDING_KEY)) return; // sticky
		localStorage.setItem(PENDING_KEY, v);
	} catch {}
}

/** Pending (URL-captured, not yet locked) referrer. May be an alias. */
export function getPendingReferral(): string | null {
	if (typeof window === 'undefined') return null;
	try {
		return localStorage.getItem(PENDING_KEY);
	} catch {
		return null;
	}
}

/** Locked referrer for a given wallet (always an address, lowercase),
 *  read from localStorage cache populated by lockReferral(). */
export function getLockedReferral(addr: string): string | null {
	if (typeof window === 'undefined' || !addr) return null;
	try {
		const v = localStorage.getItem(lockedKey(addr));
		return v && ethers.isAddress(v) ? v : null;
	} catch {
		return null;
	}
}

/** Resolve the ref to pass into a contract call. Synchronous — reads
 *  only the cached locked value. ZeroAddress when no lock or self. */
export function refOrZero(userAddress?: string | null): string {
	if (!userAddress) return ethers.ZeroAddress;
	const ref = getLockedReferral(userAddress);
	if (!ref) return ethers.ZeroAddress;
	if (ref.toLowerCase() === userAddress.toLowerCase()) return ethers.ZeroAddress;
	return ref;
}

/** Commit the pending referral to the backend for `addr`. No-op if
 *  there's no pending capture or we already have a cached lock. The
 *  server enforces first-write-wins, so calling repeatedly is safe.
 *
 *  Also performs a passive hydrate when nothing is pending — the user
 *  may have locked from a different device, so we still try a GET to
 *  populate the local cache. */
export async function lockReferral(addr: string): Promise<string | null> {
	if (typeof window === 'undefined' || !addr || !ethers.isAddress(addr)) return null;
	const me = addr.toLowerCase();
	const cached = getLockedReferral(me);
	if (cached) return cached;

	const pending = getPendingReferral();

	try {
		if (pending) {
			const res = await fetch('/api/referred', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ referral: pending }),
			});
			// 400 (invalid/self) → drop the pending so we don't retry forever.
			if (res.status === 400) {
				localStorage.removeItem(PENDING_KEY);
				return null;
			}
			if (!res.ok) return null;
			const row = await res.json();
			const referrer = (row?.referrer || '').toLowerCase();
			if (referrer && ethers.isAddress(referrer)) {
				localStorage.setItem(lockedKey(me), referrer);
				// Pending served its purpose; clear it.
				localStorage.removeItem(PENDING_KEY);
				return referrer;
			}
			return null;
		}

		// No pending — try a self-lookup in case we locked elsewhere.
		const res = await fetch(`/api/referred?addr=${me}`);
		if (!res.ok) return null;
		const row = await res.json();
		const referrer = (row?.referrer || '').toLowerCase();
		if (referrer && ethers.isAddress(referrer)) {
			localStorage.setItem(lockedKey(me), referrer);
			return referrer;
		}
		return null;
	} catch {
		return null;
	}
}

export function clearReferral(): void {
	if (typeof window === 'undefined') return;
	try {
		localStorage.removeItem(PENDING_KEY);
		// Locked refs are per-wallet and survive disconnect — leave them.
	} catch {}
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
