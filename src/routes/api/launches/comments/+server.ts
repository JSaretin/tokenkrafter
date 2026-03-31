import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

// GET /api/launches/comments?address=0x...&limit=50
export const GET: RequestHandler = async ({ url }) => {
	const address = url.searchParams.get('address');
	if (!address) {
		return error(400, 'Missing required query param: address');
	}

	const limit = Math.min(parseInt(url.searchParams.get('limit') || '50') || 50, 200);

	const { data, error: dbError } = await supabaseAdmin
		.from('comments')
		.select('*')
		.eq('launch_address', address.toLowerCase())
		.order('created_at', { ascending: false })
		.limit(limit);

	if (dbError) {
		return error(500, dbError.message);
	}

	return json(data);
};

// POST /api/launches/comments — add a new comment
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();

	const required = ['launch_address', 'chain_id', 'wallet_address', 'message'];
	for (const field of required) {
		if (!body[field]) {
			return error(400, `Missing required field: ${field}`);
		}
	}

	const message = String(body.message).trim();
	if (message.length < 1 || message.length > 500) {
		return error(400, 'Message must be between 1 and 500 characters.');
	}

	const row = {
		launch_address: body.launch_address.toLowerCase(),
		chain_id: body.chain_id,
		wallet_address: body.wallet_address.toLowerCase(),
		message
	};

	const { data, error: dbError } = await supabaseAdmin
		.from('comments')
		.insert(row)
		.select()
		.single();

	if (dbError) {
		return error(500, dbError.message);
	}

	return json(data, { status: 201 });
};
