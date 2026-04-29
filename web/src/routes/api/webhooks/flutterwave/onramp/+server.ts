/**
 * POST /api/webhooks/flutterwave/onramp
 *
 * Receives `charge.completed` events from Flutterwave when a virtual
 * account we created accepts an inbound bank transfer. We match the
 * reference against an `onramp_intents` row in `pending_payment`,
 * verify the amount, and flip the intent to `payment_received`. The
 * delivery worker (separate concern) then signs USDT.transfer to the
 * receiver address bound by the EIP-712 intent signature.
 *
 * Signature verification supports both schemes Flutterwave uses:
 *   - V4: `flutterwave-signature` header = HMAC-SHA256(rawBody, secret) base64.
 *   - V3: `verif-hash` header = secret literal.
 * Either is enough for accept; both are timing-safe-compared.
 *
 * Payload shape also varies between V3 and V4. We read fields with
 * fallbacks so the same handler works on either; FLW's V4 docs show
 * `type` + `data.reference` + `status: 'succeeded'`, V3 used `event` +
 * `data.tx_ref` + `status: 'successful'`.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { supabaseAdmin } from '$lib/supabaseServer';
import { createHmac, timingSafeEqual } from 'crypto';

function timingSafeStringEq(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

function verifySignature(rawBody: string, headers: Headers, secret: string): boolean {
	// V4: flutterwave-signature = HMAC-SHA256(body, secret) → base64.
	const v4Sig = headers.get('flutterwave-signature');
	if (v4Sig) {
		const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
		if (timingSafeStringEq(v4Sig, expected)) return true;
	}
	// V3 legacy: verif-hash = secret literal. Some FLW accounts still emit
	// this even when the dashboard says "secret hash".
	const v3Sig = headers.get('verif-hash');
	if (v3Sig && timingSafeStringEq(v3Sig, secret)) return true;
	return false;
}

const REF_PREFIXES = ['TokenKrafter-', 'TKO-'];

export const POST: RequestHandler = async ({ request }) => {
	const webhookSecret = env.FLUTTERWAVE_WEBHOOK_SECRET || env.FLUTTERWAVE_ENCRYPTION_KEY;
	if (!webhookSecret) {
		console.error('[onramp.webhook] no webhook secret configured');
		return json({ status: 'error' }, { status: 500 });
	}

	// Read raw body once — needed for HMAC verification and JSON parse.
	const rawBody = await request.text();
	if (!verifySignature(rawBody, request.headers, webhookSecret)) {
		return json({ status: 'error' }, { status: 401 });
	}

	let body: any;
	try {
		body = JSON.parse(rawBody);
	} catch {
		return json({ status: 'error' }, { status: 400 });
	}

	// V4 uses `type`, V3 uses `event`.
	const eventType: string | undefined = body?.type ?? body?.event;
	const data = body?.data;
	if (!eventType || !data) return json({ status: 'ok' });
	if (eventType !== 'charge.completed') return json({ status: 'ok' });

	// V4: data.reference (UUID-like). V3: data.tx_ref. Either is fine —
	// only ours start with the on-ramp prefix.
	const reference = data.reference ?? data.tx_ref;
	if (typeof reference !== 'string' || !REF_PREFIXES.some((p) => reference.startsWith(p))) {
		return json({ status: 'ok' });
	}

	// V4: 'succeeded'. V3: 'successful' / 'success'.
	const flwStatus = String(data.status ?? '').toLowerCase();
	if (flwStatus !== 'succeeded' && flwStatus !== 'successful' && flwStatus !== 'success') {
		console.warn('[onramp.webhook] non-success status:', reference, flwStatus);
		return json({ status: 'ok' });
	}

	const { data: row } = await supabaseAdmin
		.from('onramp_intents')
		.select('id, status, ngn_amount_kobo, flutterwave_tx_id')
		.eq('reference', reference)
		.single();
	if (!row) return json({ status: 'ok' });

	// Idempotency — re-delivery of an already-processed event is a no-op.
	const incomingTxId = String(data.id ?? data.transactionId ?? '');
	if (row.flutterwave_tx_id && row.flutterwave_tx_id === incomingTxId) {
		return json({ status: 'ok' });
	}
	if (row.status !== 'pending_payment') {
		return json({ status: 'ok' });
	}

	// Amount check (₦5 tolerance for bank-side rounding).
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

	// V4: customer is nested. V3 was flatter. Pull payer info with fallbacks
	// so analytics has *some* identity even when shapes diverge.
	const payerAccount =
		data.payment_account_number ??
		data.account_number ??
		data.payment_method?.bank_transfer?.account_number ??
		null;
	const payerName =
		data.payer_name ??
		data.account_name ??
		data.customer?.name ??
		data.payment_method?.bank_transfer?.account_name ??
		null;

	await supabaseAdmin
		.from('onramp_intents')
		.update({
			status: 'payment_received',
			paid_at: new Date().toISOString(),
			flutterwave_tx_id: incomingTxId,
			flutterwave_payer_account: payerAccount,
			flutterwave_payer_name: payerName,
		})
		.eq('reference', reference);

	return json({ status: 'ok' });
};
