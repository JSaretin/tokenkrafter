/**
 * GET /api/onramp/history?wallet=0x...
 *
 * Returns the on-ramp intents tied to a wallet, newest first. Status is
 * source-of-truth on the DB row (FLW webhook + delivery worker write to
 * it). Public read by reference-or-receiver — the wallet param IS the
 * receiver, so the caller can only see their own intents.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

export const GET: RequestHandler = async ({ url }) => {
	const wallet = url.searchParams.get('wallet')?.toLowerCase();
	if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) {
		return error(400, 'Invalid wallet');
	}

	// `failure_reason` is intentionally omitted — it holds operator-facing
	// detail like "Treasury insufficient" / contract-revert strings that
	// shouldn't reach the end user. The UI shows a generic message for
	// failed rows; technical detail stays server-side for triage.
	const { data, error: dbErr } = await supabaseAdmin
		.from('onramp_intents')
		.select('reference, status, chain_id, ngn_amount_kobo, usdt_amount_wei, rate_x100, expires_at, created_at, paid_at, delivered_at, delivery_tx_hash, flutterwave_va_account_number, flutterwave_va_bank_name')
		.eq('receiver', wallet)
		.order('created_at', { ascending: false })
		.limit(100);

	if (dbErr) {
		console.error('[onramp.history] read failed:', dbErr.message);
		return error(500, 'Failed to load history');
	}

	return json(data ?? []);
};
