/**
 * GET    /api/onramp/intent/:ref — read intent status (used for polling)
 * DELETE /api/onramp/intent/:ref — mark a quoted/pending intent as cancelled
 *
 * The reference is opaque (12+ random hex chars) which acts as the
 * read-token. A future hardening step is to require a signature over
 * { reference, "view" } for both endpoints, but for v0 the reference
 * itself is sufficient — it isn't enumerable and never appears in URLs
 * outside the user's own session.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

export const GET: RequestHandler = async ({ params }) => {
	const ref = params.ref;
	if (!ref) return error(400, 'reference required');

	const { data: row, error: dbErr } = await supabaseAdmin
		.from('onramp_intents')
		.select('reference, status, receiver, ngn_amount_kobo, usdt_amount_wei, delivery_tx_hash, failure_reason, expires_at')
		.eq('reference', ref)
		.single();
	if (dbErr || !row) return error(404, 'Not found');

	return json({
		reference: row.reference,
		status: row.status,
		receiver: row.receiver,
		ngn_amount_kobo: row.ngn_amount_kobo,
		usdt_amount_wei: row.usdt_amount_wei,
		delivery_tx_hash: row.delivery_tx_hash,
		failure_reason: row.failure_reason,
		expires_at: row.expires_at,
	});
};

export const DELETE: RequestHandler = async ({ params }) => {
	const ref = params.ref;
	if (!ref) return error(400, 'reference required');

	const { data: row } = await supabaseAdmin
		.from('onramp_intents')
		.select('status')
		.eq('reference', ref)
		.single();
	if (!row) return error(404, 'Not found');
	// Only stoppable while pre-payment.
	if (row.status !== 'quoted' && row.status !== 'pending_payment') {
		return error(409, 'Cannot cancel after payment received');
	}

	await supabaseAdmin
		.from('onramp_intents')
		.update({ status: 'cancelled' })
		.eq('reference', ref);

	return json({ ok: true });
};
