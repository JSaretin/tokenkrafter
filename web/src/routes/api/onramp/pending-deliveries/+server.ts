/**
 * GET /api/onramp/pending-deliveries
 *
 * Returns references of on-ramp intents that need USDT delivery
 * (status = 'payment_received'). Auth: vault-level (SYNC_SECRET) — only
 * the on-ramp delivery daemon should hit this.
 *
 * The companion `/api/onramp/deliver` endpoint does the actual USDT
 * transfer for a given reference.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { isVaultAuth } from '$lib/daemonAuth';

export const GET: RequestHandler = async ({ request }) => {
	if (!isVaultAuth(request)) return error(401, 'Vault auth required');

	const { data, error: dbErr } = await supabaseAdmin
		.from('onramp_intents')
		.select('reference, chain_id, ngn_amount_kobo, usdt_amount_wei, receiver, paid_at')
		.eq('status', 'payment_received')
		.order('paid_at', { ascending: true })
		.limit(50);

	if (dbErr) {
		console.error('[onramp.pending] read failed:', dbErr.message);
		return error(500, 'Failed to read pending deliveries');
	}

	return json(data ?? []);
};
