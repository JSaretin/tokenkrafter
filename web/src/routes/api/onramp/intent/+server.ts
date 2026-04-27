/**
 * POST /api/onramp/intent
 * Body: { intent: OnrampIntent, signature: hex }
 *
 * Verifies the EIP-712 signature recovers to intent.receiver, then
 * creates a Flutterwave v4 dynamic virtual account for the exact
 * amount and returns the bank details to the user. The receiver
 * cannot be redirected after this point — USDT is delivered to the
 * signed address only.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ethers } from 'ethers';
import { supabaseAdmin } from '$lib/supabaseServer';
import { ONRAMP_DOMAIN, ONRAMP_TYPES, type OnrampIntent } from '$lib/onramp/types';
import { createCustomer, createVirtualAccount } from '$lib/flutterwave';

function isHex32(v: unknown): v is string {
	return typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v);
}

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const intent = body?.intent as OnrampIntent | undefined;
	const signature = body?.signature as string | undefined;

	// Shape validation
	if (!intent || typeof intent !== 'object') return error(400, 'Missing intent');
	if (!signature || typeof signature !== 'string') return error(400, 'Missing signature');
	if (!ethers.isAddress(intent.receiver)) return error(400, 'Invalid receiver');
	if (!isHex32(intent.nonce)) return error(400, 'Invalid nonce');
	if (!intent.reference || typeof intent.reference !== 'string') return error(400, 'Invalid reference');

	// Look up the issued intent
	const { data: row, error: lookupErr } = await supabaseAdmin
		.from('onramp_intents')
		.select('*')
		.eq('reference', intent.reference)
		.single();
	if (lookupErr || !row) return error(404, 'Quote not found — request a new one');
	if (row.status !== 'quoted') return error(409, 'Quote already used or expired');
	if (new Date(row.expires_at).getTime() < Date.now()) return error(410, 'Quote expired');

	// Cross-check signed values against the issued quote (defence against
	// a tampered intent body that recovers a valid sig from a different
	// receiver but with mismatched amount/rate).
	if (
		BigInt(intent.ngnAmount) !== BigInt(row.ngn_amount_kobo) ||
		BigInt(intent.usdtAmount) !== BigInt(row.usdt_amount_wei) ||
		BigInt(intent.rate) !== BigInt(row.rate_x100) ||
		intent.nonce.toLowerCase() !== String(row.nonce).toLowerCase() ||
		BigInt(intent.expiresAt) !== BigInt(Math.floor(new Date(row.expires_at).getTime() / 1000)) ||
		Number(intent.chainId) !== Number(row.chain_id)
	) {
		return error(400, 'Intent values do not match the issued quote');
	}

	// Verify the signature
	let recovered: string;
	try {
		recovered = ethers.verifyTypedData(ONRAMP_DOMAIN(Number(intent.chainId)), ONRAMP_TYPES, intent, signature);
	} catch (e) {
		return error(400, 'Invalid signature: ' + (e as Error).message);
	}
	if (recovered.toLowerCase() !== intent.receiver.toLowerCase()) {
		return error(401, 'Signature does not match receiver');
	}

	// Create a one-shot Flutterwave customer for this intent. We use a
	// synthetic email to keep the flow non-PII pre-KYC; FLW accepts any
	// well-formed string and the customer is only used to bind the VA.
	const email = `onramp+${intent.reference.toLowerCase()}@tokenkrafter.local`;
	const lastNameSuffix = intent.receiver.slice(2, 8);
	const customer = await createCustomer({
		firstName: 'Onramp',
		lastName: `User_${lastNameSuffix}`,
		email,
	});
	if (!customer.customerId) {
		console.error('[onramp.intent] FLW customer creation failed:', customer.error);
		return error(502, 'Could not initialize payment: ' + (customer.error ?? 'customer error'));
	}

	// Create dynamic VA pinned to this exact amount. Expires 15 min
	// after creation; FLW will reject any payment outside the window.
	const ngnWhole = Number(intent.ngnAmount) / 100;
	const va = await createVirtualAccount({
		customerId: customer.customerId,
		amount: ngnWhole,
		reference: intent.reference,
		narration: `TokenKrafter on-ramp ${intent.reference}`,
		type: 'dynamic',
		expiry: 900,
	});
	if (!va.success) {
		console.error('[onramp.intent] FLW VA creation failed:', va.error);
		return error(502, 'Could not initialize payment: ' + (va.error ?? 'va error'));
	}

	// Persist the verified intent
	const { error: updErr } = await supabaseAdmin
		.from('onramp_intents')
		.update({
			receiver: intent.receiver.toLowerCase(),
			signature,
			signed_at: new Date().toISOString(),
			status: 'pending_payment',
			flutterwave_customer_id: customer.customerId,
			flutterwave_va_account_number: va.accountNumber,
			flutterwave_va_bank_name: va.bankName,
		})
		.eq('reference', intent.reference);
	if (updErr) {
		console.error('[onramp.intent] update failed:', updErr.message);
		return error(500, 'Failed to persist intent');
	}

	return json({
		reference: intent.reference,
		bank_details: {
			account_number: va.accountNumber,
			bank_name: va.bankName,
			account_name: `TokenKrafter / ${intent.reference}`,
			amount_ngn: ngnWhole,
			reference: intent.reference,
			expires_at: va.expiresAt ?? null,
		},
	});
};
