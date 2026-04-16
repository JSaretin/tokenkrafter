import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { isDaemonAuth } from '$lib/daemonAuth';

// PATCH /api/withdrawals/sync-status — daemon-only (isDaemonAuth)
export const PATCH: RequestHandler = async ({ request }) => {
	if (!isDaemonAuth(request)) return error(401, 'Unauthorized');

	const body = await request.json();
	const { id, status: newStatus, admin_note } = body;

	if (!id || !newStatus) return error(400, 'id and status required');
	if (!['pending', 'confirmed', 'cancelled'].includes(newStatus)) {
		return error(400, 'Invalid status');
	}

	const update: any = {
		status: newStatus,
		updated_at: new Date().toISOString()
	};
	if (newStatus === 'confirmed') update.confirmed_at = new Date().toISOString();
	if (admin_note) update.admin_note = admin_note;

	const { data, error: dbErr } = await supabaseAdmin
		.from('withdrawal_requests')
		.update(update)
		.eq('id', id)
		.select()
		.single();

	if (dbErr) {
		console.error('[withdrawals sync-status] DB error:', dbErr.message);
		return error(500, 'Failed to sync withdrawal status');
	}

	return json(data);
};
