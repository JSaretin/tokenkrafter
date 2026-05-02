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

// POST /api/referred — lock the addr's referrer first-write-wins.
//
// Intentionally unauthenticated: a brand-new wallet connect happens
// before any signing, and we want the lock to land at connect time.
// The asymmetry is fine because:
//   - the only thing this endpoint can do is INSERT (table has no
//     update path), and the row is first-write-wins;
//   - to abuse it an attacker would need to enumerate target wallet
//     addresses ahead of when those users connect, which is the same
//     attack surface as guessing wallet addresses generally;
//   - the on-chain effect is bounded — a wallet's referrer only
//     affects that wallet's own future trades.
// The GET below is auth'd because the referral graph itself is
// privacy-sensitive.
//
// Body: { addr: string, referral: string }  // address; address or alias
// 200:  { wallet_address, referrer, created_at, locked: bool }
//        `locked` is true when the row already existed (first-write-wins
//        kept the prior referrer); false when this call inserted a new row.
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	const rawAddr = body?.addr;
	const rawRef = body?.referral;

	if (typeof rawAddr !== 'string' || !ethers.isAddress(rawAddr)) {
		return error(400, 'addr (a valid address) required');
	}
	if (typeof rawRef !== 'string' || !rawRef) {
		return error(400, 'referral required');
	}
	const me = rawAddr.toLowerCase();

	const referrer = await resolveReferral(rawRef);
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

// GET /api/referred?addr=0x... — open lookup of the locked referrer.
// Returns { referrer: null } when not yet locked.
//
// Open by design: a fresh connect happens before any signing, and the
// FE needs to hydrate the referrer at connect time. The leak is that
// you can ask "who referred address X?" — same shape as on-chain data
// once the affiliate contract sees the trade, so no real exposure.
export const GET: RequestHandler = async ({ url }) => {
	const addr = (url.searchParams.get('addr') || '').toLowerCase();
	if (!addr || !ethers.isAddress(addr)) return error(400, 'addr required');

	const { data } = await supabaseAdmin
		.from('referred')
		.select('wallet_address, referrer, created_at')
		.eq('wallet_address', addr)
		.single();

	const body = { referrer: data?.referrer ?? null, created_at: data?.created_at ?? null };

	// Once a referrer is locked the row is immutable (table has no
	// update path), so we tell the browser to keep the response for a
	// year. `public` because the endpoint itself is unauth'd — same
	// shape as on-chain queryable data. When no row exists yet we don't
	// cache; the next visit might be the one that creates it.
	const headers: Record<string, string> = body.referrer
		? { 'Cache-Control': 'public, max-age=31536000, immutable' }
		: { 'Cache-Control': 'no-store' };

	return json(body, { headers });
};
