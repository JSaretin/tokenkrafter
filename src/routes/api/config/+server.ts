import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { verifyAdminSession } from '$lib/auth';

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

// PATCH /api/config — admin-only (session cookie)
export const PATCH: RequestHandler = async ({ request, cookies }) => {
	const token = cookies.get('admin_session');
	if (!token) return error(401, 'Not authenticated');

	const wallet = await verifyAdminSession(token);
	if (!wallet) return error(401, 'Session expired');

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
