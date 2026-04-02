import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

// GET /api/config?keys=networks,site,social_links
export const GET: RequestHandler = async ({ url }) => {
	const keys = url.searchParams.get('keys')?.split(',') || ['networks', 'site', 'social_links'];

	const { data, error: dbErr } = await supabaseAdmin
		.from('platform_config')
		.select('key, value, updated_at')
		.in('key', keys);

	if (dbErr) return error(500, dbErr.message);

	const result: Record<string, any> = {};
	for (const row of data || []) {
		result[row.key] = row.value;
	}

	return json(result);
};

// PATCH /api/config — admin-only
// Auth: admin session (hooks.server.ts)
export const PATCH: RequestHandler = async ({ request, locals }) => {
	if (!locals.isAdmin) return error(401, 'Admin access required');

	const body = await request.json();
	const { key, value } = body;

	if (!key || value === undefined) {
		return error(400, 'key and value required');
	}

	const { data, error: dbErr } = await supabaseAdmin
		.from('platform_config')
		.upsert({ key, value }, { onConflict: 'key' })
		.select()
		.single();

	if (dbErr) return error(500, dbErr.message);

	return json(data);
};
