import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { isDaemonAuth } from '$lib/daemonAuth';

// GET /api/launches/transactions?address=0x...&limit=20
export const GET: RequestHandler = async ({ url }) => {
	const address = url.searchParams.get('address');
	if (!address) {
		return error(400, 'Missing required query param: address');
	}

	const limit = Math.min(parseInt(url.searchParams.get('limit') || '20') || 20, 100);

	const { data, error: dbError } = await supabaseAdmin
		.from('launch_transactions')
		.select('*')
		.eq('launch_address', address.toLowerCase())
		.order('created_at', { ascending: false })
		.limit(limit);

	if (dbError) {
		return error(500, dbError.message);
	}

	return json(data);
};

// POST /api/launches/transactions — daemon-only (isDaemonAuth)
export const POST: RequestHandler = async ({ request }) => {
	if (!isDaemonAuth(request)) return error(401, 'Unauthorized');

	const body = await request.json();

	const required = ['launch_address', 'chain_id', 'buyer', 'base_amount', 'tokens_received'];
	for (const field of required) {
		if (!body[field] && body[field] !== 0) {
			return error(400, `Missing required field: ${field}`);
		}
	}

	const row = {
		launch_address: body.launch_address.toLowerCase(),
		chain_id: body.chain_id,
		buyer: body.buyer.toLowerCase(),
		base_amount: String(body.base_amount),
		tokens_received: String(body.tokens_received),
		tx_hash: body.tx_hash || null
	};

	const { data, error: dbError } = await supabaseAdmin
		.from('launch_transactions')
		.insert(row)
		.select()
		.single();

	if (dbError) {
		return error(500, dbError.message);
	}

	return json(data, { status: 201 });
};
