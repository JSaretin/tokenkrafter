import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

// PATCH /api/launches/metadata — update off-chain metadata for a launch
// Creator passes their wallet address; we verify they own the launch in DB
export const PATCH: RequestHandler = async ({ request }) => {
	const body = await request.json();

	if (!body.address || !body.chain_id || !body.wallet_address) {
		return error(400, 'Missing address, chain_id, or wallet_address');
	}

	// Verify the caller is the creator
	const { data: launch } = await supabaseAdmin
		.from('launches')
		.select('creator')
		.eq('address', body.address.toLowerCase())
		.eq('chain_id', body.chain_id)
		.single();

	if (!launch) {
		return error(404, 'Launch not found');
	}

	if (launch.creator !== body.wallet_address.toLowerCase()) {
		return error(403, 'Only the launch creator can update metadata');
	}

	const updates: Record<string, string | undefined> = {};
	if (body.description !== undefined) updates.description = body.description;
	if (body.logo_url !== undefined) updates.logo_url = body.logo_url;
	if (body.website !== undefined) updates.website = body.website;
	if (body.twitter !== undefined) updates.twitter = body.twitter;
	if (body.telegram !== undefined) updates.telegram = body.telegram;
	if (body.discord !== undefined) updates.discord = body.discord;

	if (Object.keys(updates).length === 0) {
		return error(400, 'No metadata fields provided');
	}

	const { data, error: dbError } = await supabaseAdmin
		.from('launches')
		.update(updates)
		.eq('address', body.address.toLowerCase())
		.eq('chain_id', body.chain_id)
		.select()
		.single();

	if (dbError) {
		return error(500, dbError.message);
	}

	return json(data);
};
