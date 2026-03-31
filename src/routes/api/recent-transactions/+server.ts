import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

// GET /api/recent-transactions?chain_id=56&limit=20&launch=0x...
export const GET: RequestHandler = async ({ url }) => {
	const chainId = url.searchParams.get('chain_id');
	const limit = parseInt(url.searchParams.get('limit') || '20');
	const launchAddress = url.searchParams.get('launch');

	let query = supabaseAdmin
		.from('recent_transactions')
		.select('*')
		.order('created_at', { ascending: false })
		.limit(Math.min(limit, 100));

	if (chainId) {
		query = query.eq('chain_id', parseInt(chainId));
	}
	if (launchAddress) {
		query = query.eq('launch_address', launchAddress.toLowerCase());
	}

	const { data, error: dbError } = await query;

	if (dbError) {
		return error(500, dbError.message);
	}

	return json(data || []);
};

// POST /api/recent-transactions — add a new transaction (called by daemon or real buy handler)
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();

	const { error: dbError } = await supabaseAdmin
		.from('recent_transactions')
		.insert({
			chain_id: body.chain_id,
			launch_address: body.launch_address?.toLowerCase(),
			token_symbol: body.token_symbol,
			token_name: body.token_name,
			buyer: body.buyer?.toLowerCase(),
			tokens_amount: body.tokens_amount || '0',
			base_amount: body.base_amount || '0',
			base_symbol: body.base_symbol || 'USDT',
			base_decimals: body.base_decimals || 6,
			token_decimals: body.token_decimals || 18,
			tx_hash: body.tx_hash,
		});

	if (dbError) {
		return error(500, dbError.message);
	}

	return json({ ok: true });
};
