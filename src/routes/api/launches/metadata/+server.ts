import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { recoverWallet } from '$lib/auth';

// PATCH /api/launches/metadata — update off-chain metadata for a launch
// Requires wallet signature; recovered address must match DB creator
export const PATCH: RequestHandler = async ({ request }) => {
	const body = await request.json();

	if (!body.address || !body.chain_id) {
		return error(400, 'Missing address or chain_id');
	}
	if (!body.signature || !body.signed_message) {
		return error(400, 'Signature required');
	}

	let walletAddress: string;
	try {
		walletAddress = recoverWallet(body.signature, body.signed_message);
	} catch (e: any) {
		return error(400, e.message || 'Invalid signature');
	}

	// Verify the recovered address is the creator
	const { data: launch } = await supabaseAdmin
		.from('launches')
		.select('creator')
		.eq('address', body.address.toLowerCase())
		.eq('chain_id', body.chain_id)
		.single();

	if (!launch) {
		return error(404, 'Launch not found');
	}

	if (launch.creator !== walletAddress) {
		return error(403, 'Only the launch creator can update metadata');
	}

	const updates: Record<string, string | null> = {};
	if (body.description !== undefined) updates.description = body.description || null;
	if (body.logo_url !== undefined) updates.logo_url = body.logo_url || null;
	if (body.website !== undefined) updates.website = body.website || null;
	if (body.twitter !== undefined) updates.twitter = body.twitter || null;
	if (body.telegram !== undefined) updates.telegram = body.telegram || null;
	if (body.discord !== undefined) updates.discord = body.discord || null;
	if (body.video_url !== undefined) updates.video_url = body.video_url || null;

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
