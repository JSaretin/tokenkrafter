import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { recoverWallet } from '$lib/auth';
import { ethers } from 'ethers';

// GET /api/token-alias?alias=MAMA — resolve alias to token address + chain_id
// GET /api/token-alias?address=0x... — get alias for token address
export const GET: RequestHandler = async ({ url }) => {
	const alias = url.searchParams.get('alias');
	const address = url.searchParams.get('address');

	if (alias) {
		const { data } = await supabaseAdmin
			.from('token_aliases')
			.select('token_address, chain_id')
			.eq('alias', alias.toLowerCase())
			.single();

		if (!data) return json({ address: null, chain_id: null });
		return json({ address: data.token_address, chain_id: data.chain_id });
	}

	if (address) {
		const { data } = await supabaseAdmin
			.from('token_aliases')
			.select('alias')
			.eq('token_address', address.toLowerCase())
			.single();

		return json({ alias: data?.alias || null });
	}

	return error(400, 'alias or address required');
};

// POST /api/token-alias — create or update alias (requires wallet signature)
// Body: { alias, token_address, chain_id, signature, signed_message }
// Signer must be the token creator (from created_tokens table) or an admin
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { alias, token_address, chain_id, signature, signed_message } = body;

	if (!alias || !token_address || !chain_id || !signature || !signed_message) {
		return error(400, 'alias, token_address, chain_id, signature, and signed_message required');
	}

	if (!ethers.isAddress(token_address)) {
		return error(400, 'Invalid token address');
	}

	// Validate alias format
	const cleanAlias = alias.toLowerCase().trim();
	if (!/^[a-z0-9_-]{2,30}$/.test(cleanAlias)) {
		return error(400, 'Alias must be 2-30 characters, lowercase letters, numbers, hyphens, or underscores');
	}

	// Reserved words
	const reserved = [
		'admin', 'tokenkrafter', 'support', 'help', 'team', 'trade', 'create',
		'launch', 'launchpad', 'explore', 'api', 'null', 'undefined',
		'eth', 'btc', 'usdt', 'usdc', 'bnb', 'matic', 'sol'
	];
	if (reserved.includes(cleanAlias)) {
		return error(400, 'This alias is reserved');
	}

	// Verify signature
	let recovered: string;
	try {
		recovered = recoverWallet(signature, signed_message);
	} catch (e: any) {
		return error(400, e.message || 'Invalid signature');
	}

	// Check if signer is the token creator or admin
	const { data: tokenRow } = await supabaseAdmin
		.from('created_tokens')
		.select('creator')
		.eq('address', token_address.toLowerCase())
		.eq('chain_id', chain_id)
		.single();

	const isCreator = tokenRow && tokenRow.creator.toLowerCase() === recovered;

	// Check admin
	const { ADMIN_WALLETS } = await import('$env/dynamic/private').then(m => m.env).then(e => ({ ADMIN_WALLETS: e.ADMIN_WALLETS || '' }));
	const admins = ADMIN_WALLETS.split(',').map((a: string) => a.trim().toLowerCase()).filter(Boolean);
	const isAdmin = admins.includes(recovered);

	if (!isCreator && !isAdmin) {
		return error(403, 'Only the token creator or an admin can set an alias');
	}

	// Check if alias is taken by a different token
	const { data: existing } = await supabaseAdmin
		.from('token_aliases')
		.select('id, token_address')
		.eq('alias', cleanAlias)
		.single();

	if (existing && existing.token_address.toLowerCase() !== token_address.toLowerCase()) {
		return error(409, 'Alias already taken by another token');
	}

	// Check if this token already has an alias
	const { data: tokenAlias } = await supabaseAdmin
		.from('token_aliases')
		.select('id, alias')
		.eq('token_address', token_address.toLowerCase())
		.eq('chain_id', chain_id)
		.single();

	if (tokenAlias) {
		// Update existing alias
		const { data, error: dbErr } = await supabaseAdmin
			.from('token_aliases')
			.update({ alias: cleanAlias })
			.eq('id', tokenAlias.id)
			.select()
			.single();

		if (dbErr) return error(500, dbErr.message);
		return json(data);
	}

	// Create new
	const { data, error: dbErr } = await supabaseAdmin
		.from('token_aliases')
		.insert({
			alias: cleanAlias,
			token_address: token_address.toLowerCase(),
			chain_id,
			creator: recovered
		})
		.select()
		.single();

	if (dbErr) return error(500, dbErr.message);
	return json(data);
};
