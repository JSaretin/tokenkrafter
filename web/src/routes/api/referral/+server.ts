import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

// GET /api/referral?alias=john — resolve alias to wallet address
// GET /api/referral?wallet=0x... — get alias for wallet
export const GET: RequestHandler = async ({ url }) => {
	const alias = url.searchParams.get('alias');
	const wallet = url.searchParams.get('wallet');

	if (alias) {
		const { data } = await supabaseAdmin
			.from('referral_aliases')
			.select('wallet_address')
			.eq('alias', alias.toLowerCase())
			.single();

		if (!data) return json({ address: null });
		return json({ address: data.wallet_address });
	}

	if (wallet) {
		const { data } = await supabaseAdmin
			.from('referral_aliases')
			.select('alias')
			.eq('wallet_address', wallet.toLowerCase())
			.single();

		return json({ alias: data?.alias || null });
	}

	return error(400, 'alias or wallet required');
};

// POST /api/referral — create alias (requires wallet signature)
// Auth: wallet session (hooks.server.ts)
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.wallet) return error(401, 'Wallet authentication required');

	const body = await request.json();
	const { alias } = body;
	const wallet_address = locals.wallet;

	if (!alias) {
		return error(400, 'alias required');
	}

	// Validate alias format
	const cleanAlias = alias.toLowerCase().trim();
	if (!/^[a-z0-9_-]{3,20}$/.test(cleanAlias)) {
		return error(400, 'Alias must be 3-20 characters, lowercase letters, numbers, hyphens, or underscores');
	}

	// Reserved words
	const reserved = ['admin', 'tokenkrafter', 'support', 'help', 'team', 'trade', 'create', 'launch', 'launchpad', 'explore', 'api', 'null', 'undefined'];
	if (reserved.includes(cleanAlias)) {
		return error(400, 'This alias is reserved');
	}

	// Check if wallet already has an alias — update it, otherwise insert.
	// Use DB unique constraint on `alias` to catch races atomically.
	const { data: walletAlias } = await supabaseAdmin
		.from('referral_aliases')
		.select('alias')
		.eq('wallet_address', wallet_address)
		.single();

	if (walletAlias) {
		// Update existing alias
		const { data, error: dbErr } = await supabaseAdmin
			.from('referral_aliases')
			.update({ alias: cleanAlias })
			.eq('wallet_address', wallet_address)
			.select()
			.single();

		if (dbErr) {
			// Unique constraint violation = alias taken by another wallet
			if (dbErr.code === '23505') return error(409, 'Alias already taken');
			console.error('[referral POST] DB error:', dbErr.message);
			return error(500, 'Failed to update alias');
		}
		return json(data);
	}

	// Create new — rely on unique constraint to prevent race conditions
	const { data, error: dbErr } = await supabaseAdmin
		.from('referral_aliases')
		.insert({
			alias: cleanAlias,
			wallet_address: wallet_address
		})
		.select()
		.single();

	if (dbErr) {
		// Unique constraint violation = alias taken by concurrent request
		if (dbErr.code === '23505') return error(409, 'Alias already taken');
		console.error('[referral POST] DB error:', dbErr.message);
		return error(500, 'Failed to create alias');
	}
	return json(data);
};
