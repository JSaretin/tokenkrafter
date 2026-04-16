import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { env } from '$env/dynamic/private';

// GET /api/config?keys=networks,site,social_links
export const GET: RequestHandler = async ({ url }) => {
	const keys = url.searchParams.get('keys')?.split(',') || ['networks', 'site', 'social_links'];

	const { data, error: dbErr } = await supabaseAdmin
		.from('platform_config')
		.select('key, value, updated_at')
		.in('key', keys);

	if (dbErr) {
		console.error('[config GET] DB error:', dbErr.message);
		return error(500, 'Failed to fetch config');
	}

	const result: Record<string, any> = {};
	for (const row of data || []) {
		result[row.key] = row.value;
	}

	return json(result);
};

// PATCH /api/config — admin or daemon
// Auth: admin session (hooks.server.ts) OR TX_CONFIRM_SECRET bearer token
export const PATCH: RequestHandler = async ({ request, locals }) => {
	const authHeader = request.headers.get('authorization');
	const isDaemon = env.TX_CONFIRM_SECRET && authHeader === `Bearer ${env.TX_CONFIRM_SECRET}`;
	if (!locals.isAdmin && !isDaemon) return error(401, 'Admin access required');

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

	if (dbErr) {
		console.error('[config PATCH] DB error:', dbErr.message);
		return error(500, 'Failed to update config');
	}

	return json(data);
};
