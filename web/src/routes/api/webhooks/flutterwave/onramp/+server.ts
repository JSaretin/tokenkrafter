/**
 * POST /api/webhooks/flutterwave/onramp
 * Flutterwave sends `charge.completed` events here when a virtual
 * account receives an inbound transfer. We match the tx_ref against
 * an `onramp_intents` row in `pending_payment` state, validate the
 * amount, and flip the intent to `payment_received`. The delivery
 * worker (separate concern) signs USDT.transfer to intent.receiver.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { supabaseAdmin } from '$lib/supabaseServer';
import { timingSafeEqual } from 'crypto';

function timingSafeCompare(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

export const POST: RequestHandler = async ({ request }) => {
	// Same shared-secret hash header as the existing FLW webhook.
	const signature = request.headers.get('verif-hash');
	const webhookSecret = env.FLUTTERWAVE_WEBHOOK_SECRET || env.FLUTTERWAVE_ENCRYPTION_KEY;
	if (!webhookSecret) {
		console.error('[onramp.webhook] no webhook secret configured');
		return json({ status: 'error' }, { status: 500 });
	}
	if (!signature || !timingSafeCompare(signature, webhookSecret)) {
		return json({ status: 'error' }, { status: 401 });
	}

	const body = await request.json().catch(() => null);
	const event: string | undefined = body?.event;
	const data = body?.data;
	if (!event || !data) return json({ status: 'ok' });

	// Only interested in inbound payments
	if (event !== 'charge.completed') return json({ status: 'ok' });

	const reference = data.tx_ref || data.reference;
	if (typeof reference !== 'string' || !reference.startsWith('TKO-')) {
		return json({ status: 'ok' });
	}

	const flwStatus = String(data.status ?? '').toLowerCase();
	if (flwStatus !== 'successful' && flwStatus !== 'success') {
		// Failed payment — best to log and let the user retry.
		console.warn('[onramp.webhook] non-success status:', reference, flwStatus);
		return json({ status: 'ok' });
	}

	// Look up the intent
	const { data: row } = await supabaseAdmin
		.from('onramp_intents')
		.select('id, status, ngn_amount_kobo, flutterwave_tx_id')
		.eq('reference', reference)
		.single();
	if (!row) return json({ status: 'ok' });

	// Idempotency — if we already processed this tx, ignore re-delivery
	const incomingTxId = String(data.id ?? data.transactionId ?? '');
	if (row.flutterwave_tx_id && row.flutterwave_tx_id === incomingTxId) {
		return json({ status: 'ok' });
	}
	if (row.status !== 'pending_payment') {
		// Already moved on — refunded, delivered, etc. Ignore.
		return json({ status: 'ok' });
	}

	// Amount check (₦5 tolerance for bank-side rounding)
	const expectedNgn = Number(row.ngn_amount_kobo) / 100;
	const paidNgn = Number(data.amount);
	if (!Number.isFinite(paidNgn) || Math.abs(paidNgn - expectedNgn) > 5) {
		await supabaseAdmin
			.from('onramp_intents')
			.update({
				status: 'failed',
				failure_reason: `Amount mismatch: paid ₦${paidNgn}, expected ₦${expectedNgn}`,
				flutterwave_tx_id: incomingTxId,
			})
			.eq('reference', reference);
		return json({ status: 'ok' });
	}

	await supabaseAdmin
		.from('onramp_intents')
		.update({
			status: 'payment_received',
			paid_at: new Date().toISOString(),
			flutterwave_tx_id: incomingTxId,
			flutterwave_payer_account: data.payment_account_number ?? data.account_number ?? null,
			flutterwave_payer_name: data.payer_name ?? data.account_name ?? null,
		})
		.eq('reference', reference);

	// Delivery is a separate concern — operator picks it up from
	// /_/onramp for v0; auto-delivery worker arrives in a later commit.
	return json({ status: 'ok' });
};
