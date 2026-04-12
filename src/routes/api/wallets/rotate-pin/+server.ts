/**
 * Batch PIN rotation — atomic re-encryption of every wallet in one request.
 *
 *   POST /api/wallets/rotate-pin
 *   Body: { updates: Array<{ id: string; primaryBlob: string }> }
 *
 * Iterates over the updates array and issues individual `.update()` calls
 * scoped by both `id` and `user_id`. Using update (not upsert) ensures a
 * wallet that was deleted between the ownership check and the write is
 * silently skipped rather than resurrected as a new row.
 *
 * Security:
 *   - JWT required. The SQL function scopes its UPDATE by the caller's
 *     user_id and aborts the transaction if the row count doesn't match
 *     the input length, so a smuggled foreign id rolls back everything.
 *   - The ciphertext itself is opaque to the server; the client is
 *     responsible for re-encrypting each blob correctly before sending.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

async function getAuthUser(request: Request): Promise<string> {
	const authHeader = request.headers.get('authorization');
	if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing auth token');
	const token = authHeader.slice(7);
	const { data, error: authError } = await supabaseAdmin.auth.getUser(token);
	if (authError || !data.user) throw new Error('Invalid or expired token');
	return data.user.id;
}

export const POST: RequestHandler = async ({ request }) => {
	let userId: string;
	try {
		userId = await getAuthUser(request);
	} catch (e: any) {
		return error(401, e.message);
	}

	const body = await request.json();
	const updates: Array<{ id: string; primaryBlob: string }> = body.updates;

	if (!Array.isArray(updates) || updates.length === 0) {
		return error(400, 'updates array required');
	}
	if (updates.length > 50) {
		// Defensive cap — no real user has more than a handful of wallets.
		return error(400, 'too many wallets in a single rotation');
	}
	for (const u of updates) {
		if (!u.id || typeof u.id !== 'string') return error(400, 'each update needs an id');
		if (!u.primaryBlob || typeof u.primaryBlob !== 'string') return error(400, 'each update needs a primaryBlob');
	}

	// Verify every id belongs to the caller BEFORE writing. If the client
	// tries to smuggle in a wallet id from another user, we reject the
	// whole batch — never write a partial set.
	const ids = updates.map((u) => u.id);
	const { data: owned, error: ownErr } = await supabaseAdmin
		.from('wallets')
		.select('id')
		.eq('user_id', userId)
		.in('id', ids);

	if (ownErr) return error(500, ownErr.message);
	const ownedSet = new Set((owned || []).map((r) => r.id));
	for (const id of ids) {
		if (!ownedSet.has(id)) return error(403, 'wallet not owned by caller');
	}

	// Update each wallet individually — we use .update() instead of
	// .upsert() to guarantee we never accidentally INSERT a row for a
	// wallet that was deleted between the ownership check and the write.
	const nowIso = new Date().toISOString();
	let rotated = 0;
	for (const u of updates) {
		const { error: updErr, count } = await supabaseAdmin
			.from('wallets')
			.update({ primary_blob: u.primaryBlob, updated_at: nowIso })
			.eq('id', u.id)
			.eq('user_id', userId);

		if (updErr) return error(500, updErr.message);
		rotated++;
	}

	return json({ ok: true, rotated });
};
