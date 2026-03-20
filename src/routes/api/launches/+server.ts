import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

// GET /api/launches — list launches with optional filters
export const GET: RequestHandler = async ({ url }) => {
	const chainId = url.searchParams.get('chain_id');
	const state = url.searchParams.get('state');
	const creator = url.searchParams.get('creator');
	const address = url.searchParams.get('address');
	const limit = Math.min(parseInt(url.searchParams.get('limit') || '50') || 50, 100);
	const offset = parseInt(url.searchParams.get('offset') || '0') || 0;

	let query = supabaseAdmin
		.from('launches')
		.select('*')
		.order('created_at', { ascending: false })
		.range(offset, offset + limit - 1);

	if (address) query = query.eq('address', address.toLowerCase());
	if (chainId) query = query.eq('chain_id', parseInt(chainId));
	if (state) query = query.eq('state', parseInt(state));
	if (creator) query = query.ilike('creator', creator);

	const { data, error: dbError } = await query;

	if (dbError) {
		return error(500, dbError.message);
	}

	return json(data);
};

// POST /api/launches — upsert a launch (called after on-chain creation or sync)
// Protected: only internal callers (sync cron, create page) should call this.
// In production, add an API key or restrict to server-side callers.
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();

	const required = ['address', 'chain_id', 'token_address', 'creator'];
	for (const field of required) {
		if (!body[field]) {
			return error(400, `Missing required field: ${field}`);
		}
	}

	const row = {
		address: body.address.toLowerCase(),
		chain_id: body.chain_id,
		token_address: body.token_address.toLowerCase(),
		creator: body.creator.toLowerCase(),
		curve_type: body.curve_type ?? 0,
		state: body.state ?? 0,
		soft_cap: body.soft_cap ?? '0',
		hard_cap: body.hard_cap ?? '0',
		total_base_raised: body.total_base_raised ?? '0',
		tokens_sold: body.tokens_sold ?? '0',
		tokens_for_curve: body.tokens_for_curve ?? '0',
		tokens_for_lp: body.tokens_for_lp ?? '0',
		creator_allocation_bps: body.creator_allocation_bps ?? 0,
		current_price: body.current_price ?? '0',
		deadline: body.deadline ?? 0,
		start_timestamp: body.start_timestamp ?? 0,
		total_tokens_required: body.total_tokens_required ?? '0',
		total_tokens_deposited: body.total_tokens_deposited ?? '0',
		token_name: body.token_name,
		token_symbol: body.token_symbol,
		token_decimals: body.token_decimals ?? 18,
		usdt_decimals: body.usdt_decimals ?? 18,
		description: body.description,
		logo_url: body.logo_url,
		website: body.website,
		twitter: body.twitter,
		telegram: body.telegram,
		discord: body.discord,
		video_url: body.video_url
	};

	const { data, error: dbError } = await supabaseAdmin
		.from('launches')
		.upsert(row, { onConflict: 'address,chain_id' })
		.select()
		.single();

	if (dbError) {
		return error(500, dbError.message);
	}

	return json(data, { status: 201 });
};
