import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { env } from '$env/dynamic/private';

// PATCH /api/withdrawals/sync-status — daemon-only, sync on-chain status to DB
export const PATCH: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('authorization');
	if (!env.SYNC_SECRET || authHeader !== `Bearer ${env.SYNC_SECRET}`) {
		return error(401, 'Unauthorized');
	}

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

	if (dbErr) return error(500, dbErr.message);

	return json(data);
};
