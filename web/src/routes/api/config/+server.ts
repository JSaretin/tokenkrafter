import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { isDaemonAuth } from '$lib/daemonAuth';

// GET /api/config?keys=networks,site,social_links
export const GET: RequestHandler = async ({ url, request, locals }) => {
	const keys = url.searchParams.get('keys')?.split(',') || ['networks', 'site', 'social_links'];

	const { data, error: dbErr } = await supabaseAdmin
		.from('platform_config')
		.select('key, value, updated_at')
		.in('key', keys);

	if (dbErr) {
		console.error('[config GET] DB error:', dbErr.message);
		return error(500, 'Failed to fetch config');
	}

	// Determine if caller is a trusted daemon
	const isDaemon = isDaemonAuth(request);
	const isAdmin = !!(locals as any).isAdmin;

	const result: Record<string, any> = {};
	for (const row of data || []) {
		if (row.key === 'networks' && !isDaemon && !isAdmin) {
			// Strip daemon_rpc (private key) from network config for public callers
			result[row.key] = (row.value as any[])?.map((n: any) => {
				const { daemon_rpc, ...pub } = n;
				return pub;
			}) || [];
		} else {
			result[row.key] = row.value;
		}
	}

	return json(result);
};

// PATCH /api/config — admin or daemon
// Auth: admin session (hooks.server.ts) OR isDaemonAuth
export const PATCH: RequestHandler = async ({ request, locals }) => {
	if (!locals.isAdmin && !isDaemonAuth(request)) return error(401, 'Admin access required');

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
