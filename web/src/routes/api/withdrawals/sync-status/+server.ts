import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { isDaemonAuth } from '$lib/daemonAuth';

// POST or PATCH /api/withdrawals/sync-status — daemon-only.
//
// Two body shapes accepted:
//   1. ws-indexer (on-chain event observer):
//      { withdraw_id: number, chain_id: number, status: 'confirmed' | 'cancelled' }
//      Looks up the row by (withdraw_id, chain_id).
//
//   2. Admin tooling / legacy callers:
//      { id: bigint, status: 'pending' | 'confirmed' | 'cancelled', admin_note?: string }
//      Looks up by DB row id.
//
// We accept POST for the daemon and PATCH for legacy admin tools so existing
// callers don't break. The handler body is shared.
const handler: RequestHandler = async ({ request }) => {
	if (!isDaemonAuth(request)) return error(401, 'Unauthorized');

	const body = await request.json();
	const { id, withdraw_id, chain_id, status: newStatus, admin_note } = body;

	if (!newStatus) return error(400, 'status required');
	if (!['pending', 'confirmed', 'cancelled'].includes(newStatus)) {
		return error(400, 'Invalid status');
	}
	if (!id && (withdraw_id === undefined || !chain_id)) {
		return error(400, 'id OR (withdraw_id + chain_id) required');
	}

	const update: Record<string, unknown> = {
		status: newStatus,
		updated_at: new Date().toISOString()
	};
	if (newStatus === 'confirmed') update.confirmed_at = new Date().toISOString();
	if (admin_note) update.admin_note = admin_note;

	let query = supabaseAdmin
		.from('withdrawal_requests')
		.update(update);

	if (id) {
		query = query.eq('id', id);
	} else {
		query = query.eq('withdraw_id', withdraw_id).eq('chain_id', chain_id);
	}

	const { data, error: dbErr } = await query.select().single();

	if (dbErr) {
		// Code PGRST116 = "no rows" — not an error from the daemon's POV
		// (it just means the row hasn't been verified into the DB yet, or
		// was already in this state). Treat as a soft-skip.
		if (dbErr.code === 'PGRST116') return json({ ok: true, skipped: true });
		console.error('[withdrawals sync-status] DB error:', dbErr.message);
		return error(500, 'Failed to sync withdrawal status');
	}

	return json(data);
};

export const POST: RequestHandler = handler;
export const PATCH: RequestHandler = handler;
