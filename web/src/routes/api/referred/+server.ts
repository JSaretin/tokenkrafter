import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { ethers } from 'ethers';

// Resolve a free-form referral input (lowercase) to a 0x address.
// Accepts either an EIP-55 address or a referral alias from referral_aliases.
async function resolveReferral(raw: string): Promise<string | null> {
	const v = raw.toLowerCase().trim();
	if (!v) return null;
	if (ethers.isAddress(v)) return v;
	const { data } = await supabaseAdmin
		.from('referral_aliases')
		.select('wallet_address')
		.eq('alias', v)
		.single();
	const addr = data?.wallet_address?.toLowerCase();
	return addr && ethers.isAddress(addr) ? addr : null;
}

// POST /api/referred — lock the caller's referrer first-write-wins.
// Auth: wallet session cookie (locals.wallet). The on-the-wire `addr`
// must match the session — otherwise an attacker could pre-lock other
// users' referrers to themselves.
//
// Body: { referral: string }   // address or alias, case-insensitive
// 200:  { wallet_address, referrer, created_at, locked: bool }
//        `locked` is true when the row already existed (first-write-wins
//        kept the prior referrer); false when this call inserted a new row.
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.wallet) return error(401, 'Wallet authentication required');
	const me = locals.wallet.toLowerCase();

	const body = await request.json().catch(() => ({}));
	const raw = body?.referral;
	if (typeof raw !== 'string' || !raw) return error(400, 'referral required');

	const referrer = await resolveReferral(raw);
	if (!referrer) return error(400, 'referral is not a valid address or alias');
	if (referrer === me) return error(400, 'cannot refer yourself');
	if (referrer === ethers.ZeroAddress.toLowerCase()) {
		return error(400, 'referral cannot be zero address');
	}

	// Race-safe: insert and let the PK conflict bounce us into the
	// "already locked" branch. Single round-trip in the common case.
	const { data: inserted, error: insErr } = await supabaseAdmin
		.from('referred')
		.insert({ wallet_address: me, referrer })
		.select()
		.single();

	if (!insErr && inserted) {
		return json({ ...inserted, locked: false });
	}
	// 23505 = unique violation = first write already happened.
	if (insErr && insErr.code !== '23505') {
		console.error('[referred POST] insert failed:', insErr.message);
		return error(500, 'Failed to lock referrer');
	}

	const { data: existing } = await supabaseAdmin
		.from('referred')
		.select('*')
		.eq('wallet_address', me)
		.single();

	if (!existing) return error(500, 'Locked referrer not found after conflict');
	return json({ ...existing, locked: true });
};

// GET /api/referred?addr=0x... — service-only lookup for the locked
// referrer. Returns { referrer: null } when not yet locked.
//
// This endpoint is intentionally unauthenticated read for the caller's
// own address only — clients pass addr=<their session wallet> to
// hydrate the localStorage cache after a session restore. Service
// role bypasses RLS so the read works without a public policy.
export const GET: RequestHandler = async ({ url, locals }) => {
	const addr = (url.searchParams.get('addr') || '').toLowerCase();
	if (!addr || !ethers.isAddress(addr)) return error(400, 'addr required');

	// Lock down to "self only" — leaking the referral graph to anyone
	// who can guess addresses is the same kind of leak we just closed
	// on withdrawal_requests.
	if (!locals.wallet || locals.wallet.toLowerCase() !== addr) {
		return error(401, 'Wallet authentication required for self-lookup');
	}

	const { data } = await supabaseAdmin
		.from('referred')
		.select('wallet_address, referrer, created_at')
		.eq('wallet_address', addr)
		.single();

	return json({ referrer: data?.referrer ?? null, created_at: data?.created_at ?? null });
};
