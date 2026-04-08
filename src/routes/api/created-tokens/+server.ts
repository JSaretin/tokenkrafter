import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { env } from '$env/dynamic/private';

// GET /api/created-tokens?chain_id=56&creator=0x...
export const GET: RequestHandler = async ({ url }) => {
	const chainId = url.searchParams.get('chain_id');
	const creator = url.searchParams.get('creator');
	const limit = Math.min(parseInt(url.searchParams.get('limit') || '50') || 50, 200);

	let query = supabaseAdmin
		.from('created_tokens')
		.select('*')
		.order('created_at', { ascending: false })
		.limit(limit);

	if (chainId) query = query.eq('chain_id', parseInt(chainId));
	if (creator) query = query.ilike('creator', creator);

	const { data, error: dbErr } = await query;
	if (dbErr) return error(500, dbErr.message);

	return json(data || []);
};

// POST /api/created-tokens — daemon-only, upsert token from chain
export const POST: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('authorization');
	if (!env.SYNC_SECRET || authHeader !== `Bearer ${env.SYNC_SECRET}`) {
		return error(401, 'Unauthorized');
	}

	const body = await request.json();

	const row: Record<string, any> = {
		address: (body.address || '').toLowerCase(),
		chain_id: body.chain_id,
		creator: (body.creator || '').toLowerCase(),
		name: body.name || 'Unknown',
		symbol: body.symbol || '???',
		total_supply: body.total_supply || '0',
		decimals: body.decimals ?? 18,
		is_taxable: body.is_taxable ?? false,
		is_mintable: body.is_mintable ?? false,
		is_partner: body.is_partner ?? false,
		type_key: body.type_key ?? 0,
	};
	// Optional metadata (from activity bot or other sources)
	if (body.description) row.description = body.description;
	if (body.logo_url) row.logo_url = body.logo_url;

	const { data, error: dbErr } = await supabaseAdmin
		.from('created_tokens')
		.upsert(row, { onConflict: 'address,chain_id' })
		.select()
		.single();

	if (dbErr) return error(500, dbErr.message);

	return json(data, { status: 201 });
};
