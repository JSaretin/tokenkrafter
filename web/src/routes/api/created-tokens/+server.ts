import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { isDaemonAuth } from '$lib/daemonAuth';

// GET /api/created-tokens?chain_id=56&creator=0x...&search=baby&offset=0&limit=30
export const GET: RequestHandler = async ({ url }) => {
	const chainId = url.searchParams.get('chain_id');
	const creator = url.searchParams.get('creator');
	const search = url.searchParams.get('search')?.trim();
	const limit = Math.min(parseInt(url.searchParams.get('limit') || '50') || 50, 200);
	const offset = Math.max(parseInt(url.searchParams.get('offset') || '0') || 0, 0);

	let query = supabaseAdmin
		.from('created_tokens')
		.select('*')
		.order('created_at', { ascending: false })
		.range(offset, offset + limit - 1);

	if (chainId) query = query.eq('chain_id', parseInt(chainId));
	if (creator) query = query.ilike('creator', creator);
	if (search) {
		// Sanitize: strip PostgREST operators to prevent filter injection
		const sanitized = search.replace(/[,().]/g, '');
		if (sanitized) {
			query = query.or(`name.ilike.%${sanitized}%,symbol.ilike.%${sanitized}%,address.ilike.%${sanitized}%`);
		}
	}

	const { data, error: dbErr } = await query;
	if (dbErr) {
		console.error('[created-tokens GET] DB error:', dbErr.message);
		return error(500, 'Failed to fetch tokens');
	}

	return json(data || []);
};

// POST /api/created-tokens — daemon-only, upsert token from chain
export const POST: RequestHandler = async ({ request }) => {
	if (!isDaemonAuth(request)) return error(401, 'Unauthorized');

	const body = await request.json();

	const row: Record<string, any> = {
		address: (body.address || '').toLowerCase(),
		chain_id: body.chain_id,
		creator: (body.creator || '').toLowerCase(),
		name: body.name || 'Unknown',
		symbol: body.symbol || '???',
		decimals: body.decimals ?? 18,
		total_supply: body.total_supply || '0',
		is_taxable: body.is_taxable ?? false,
		is_mintable: body.is_mintable ?? false,
		is_partner: body.is_partner ?? false,
	};
	// Optional metadata (from activity bot or other sources)
	if (body.description) row.description = body.description;
	if (body.logo_url) row.logo_url = body.logo_url;
	if (body.website) row.website = body.website;
	if (body.twitter) row.twitter = body.twitter;
	if (body.telegram) row.telegram = body.telegram;

	const { data, error: dbErr } = await supabaseAdmin
		.from('created_tokens')
		.upsert(row, { onConflict: 'address,chain_id' })
		.select()
		.single();

	if (dbErr) {
		console.error('[created-tokens POST] DB error:', dbErr.message);
		return error(500, 'Failed to save token');
	}

	return json(data, { status: 201 });
};

// PATCH /api/created-tokens — daemon-only, update a single token's fields
export const PATCH: RequestHandler = async ({ request }) => {
	if (!isDaemonAuth(request)) return error(401, 'Unauthorized');

	const body = await request.json();
	if (!body.address || !body.chain_id) return error(400, 'address and chain_id required');

	const { address, chain_id, ...fields } = body;

	const { data, error: dbErr } = await supabaseAdmin
		.from('created_tokens')
		.update(fields)
		.eq('address', address.toLowerCase())
		.eq('chain_id', chain_id)
		.select()
		.single();

	if (dbErr) {
		console.error('[created-tokens PATCH] DB error:', dbErr.message);
		return error(500, 'Failed to update token');
	}

	return json(data);
};
