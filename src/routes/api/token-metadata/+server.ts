import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

// GET /api/token-metadata?address=0x...&chain_id=56
export const GET: RequestHandler = async ({ url }) => {
	const address = url.searchParams.get('address')?.toLowerCase();
	const chainId = parseInt(url.searchParams.get('chain_id') || '56');

	if (!address) return error(400, 'address required');

	const { data, error: dbErr } = await supabaseAdmin
		.from('created_tokens')
		.select('address, chain_id, name, symbol, decimals, creator, is_taxable, is_mintable, is_partner, total_supply, logo_url, description, website, twitter, telegram, created_at')
		.eq('address', address)
		.eq('chain_id', chainId)
		.single();

	if (dbErr) {
		if (dbErr.code === 'PGRST116') return json(null); // not found
		console.error('[token-metadata GET] DB error:', dbErr.message);
		return error(500, 'Failed to fetch token metadata');
	}

	return json(data);
};

// PUT /api/token-metadata — update metadata (requires wallet session)
// Only the token creator or an admin can update
export const PUT: RequestHandler = async ({ request, locals }) => {
	const wallet = (locals as any).wallet?.toLowerCase();
	const isAdmin = (locals as any).isAdmin;

	if (!wallet) return error(401, 'Wallet session required');

	const body = await request.json();
	const { address, chain_id, logo_url, description, website, twitter, telegram, name: tokenName, symbol, decimals, is_taxable, is_mintable, is_partner } = body;

	if (!address || !chain_id) return error(400, 'address and chain_id required');

	// Verify caller is the creator or admin
	if (!isAdmin) {
		const { data: token } = await supabaseAdmin
			.from('created_tokens')
			.select('creator')
			.eq('address', address.toLowerCase())
			.eq('chain_id', chain_id)
			.single();

		// Token exists in DB — verify ownership
		if (token && token.creator.toLowerCase() !== wallet) {
			return error(403, 'Only the token creator can update metadata');
		}
		// If token not in DB yet (daemon hasn't indexed), allow the creator to save metadata
		// The upsert below sets creator = wallet, so ownership is established
	}

	// Build metadata updates
	const updates: Record<string, any> = {};
	if (logo_url !== undefined) updates.logo_url = logo_url;
	if (description !== undefined) updates.description = description;
	if (website !== undefined) updates.website = website;
	if (twitter !== undefined) updates.twitter = twitter;
	if (telegram !== undefined) updates.telegram = telegram;

	if (Object.keys(updates).length === 0) return error(400, 'No fields to update');

	// Try update first — if token exists in DB
	const { data: existing } = await supabaseAdmin
		.from('created_tokens')
		.select('address')
		.eq('address', address.toLowerCase())
		.eq('chain_id', chain_id)
		.single();

	let data;
	if (existing) {
		// Token exists — update metadata
		const { data: d, error: dbErr } = await supabaseAdmin
			.from('created_tokens')
			.update(updates)
			.eq('address', address.toLowerCase())
			.eq('chain_id', chain_id)
			.select()
			.single();
		if (dbErr) {
			console.error('[token-metadata PUT] DB error:', dbErr.message);
			return error(500, 'Failed to update token metadata');
		}
		data = d;
	} else {
		// Token not indexed yet — create full row with all available data
		const { data: d, error: dbErr } = await supabaseAdmin
			.from('created_tokens')
			.upsert({
				address: address.toLowerCase(),
				chain_id: chain_id,
				creator: wallet,
				name: tokenName || 'Pending',
				symbol: symbol || '???',
				decimals: decimals ?? 18,
				is_taxable: is_taxable ?? false,
				is_mintable: is_mintable ?? false,
				is_partner: is_partner ?? false,
				...updates,
			}, { onConflict: 'address,chain_id' })
			.select()
			.single();
		if (dbErr) {
			console.error('[token-metadata PUT] DB error:', dbErr.message);
			return error(500, 'Failed to save token metadata');
		}
		data = d;
	}

	return json(data);
};
