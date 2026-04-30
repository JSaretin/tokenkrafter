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
import { sendTelegram } from '$lib/alerts';

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
	// receiver but with mismatched amount/rate). gasDripWei must match
	// the row exactly — the drip is paid for via a USDT deduction baked
	// into usdt_amount_wei, so any mismatch would either short-change
	// the user or let them claim a free drip.
	const rowDripWei = BigInt((row as any).gas_drip_wei ?? '0');
	if (
		BigInt(intent.ngnAmount) !== BigInt(row.ngn_amount_kobo) ||
		BigInt(intent.usdtAmount) !== BigInt(row.usdt_amount_wei) ||
		BigInt(intent.rate) !== BigInt(row.rate_x100) ||
		intent.nonce.toLowerCase() !== String(row.nonce).toLowerCase() ||
		BigInt(intent.expiresAt) !== BigInt(Math.floor(new Date(row.expires_at).getTime() / 1000)) ||
		Number(intent.chainId) !== Number(row.chain_id) ||
		BigInt(intent.gasDripWei ?? '0') !== rowDripWei
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

	// Per-intent customer. The display name is consistent ("TokenKrafter
	// Bid") so payers always see the same recipient label, but the email
	// is unique per reference because FLW v4 enforces email uniqueness on
	// the customer record. The synthetic email lives under our real
	// domain — using a reserved TLD (.local) is rejected by FLW.
	const email = `onramp+${intent.reference.toLowerCase()}@tokenkrafter.com`;
	const customer = await createCustomer({
		firstName: 'TokenKrafter',
		lastName: 'Bid',
		email,
	});
	if (!customer.customerId) {
		console.error('[onramp.intent] FLW customer creation failed:', customer.error);
		return error(502, 'Could not initialize payment: ' + (customer.error ?? 'customer error'));
	}

	// Create dynamic VA pinned to this exact amount. Expires 15 min
	// after creation; FLW will reject any payment outside the window.
	// `reference` stays TKO-XXXXXX for our webhook→intent matching.
	// `narration` is a brand string — Flutterwave seeds the NUBAN
	// account-name from this, so payers in their bank app see
	// "TokenKrafter" rather than the cryptic reference.
	const ngnWhole = Number(intent.ngnAmount) / 100;
	// FLW V4 doesn't expose `account_name` in the VA response; instead
	// they seed the NUBAN-registered account-name from `narration`
	// (dashes stripped). So narration IS the brand label the payer's
	// bank shows on lookup. Keep it the clean company name only — no
	// reference, no codes — so what the user sees in our UI matches
	// what their bank shows. `reference` is purely our webhook-matching ID.
	const va = await createVirtualAccount({
		customerId: customer.customerId,
		amount: ngnWhole,
		reference: intent.reference,
		narration: 'TokenKrafter',
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

	// Fire-and-forget Telegram alert so operators see the deposit
	// pipeline in real time. Critical info: amount, where USDT lands,
	// VA account so support can verify the bank deposit if needed.
	const usdtNet = (Number(BigInt(intent.usdtAmount) * 10000n / 10n ** 18n) / 10000).toFixed(4);
	void sendTelegram(
		'On-ramp initiated',
		[
			`💰 ₦${ngnWhole.toLocaleString()} → ${usdtNet} USDT`,
			`👤 ${intent.receiver.slice(0, 6)}…${intent.receiver.slice(-4)}`,
			`🏦 ${va.bankName ?? '—'} · ${va.accountNumber ?? '—'}`,
			`🔖 ${intent.reference}`,
		].join('\n'),
	).catch(() => {});

	return json({
		reference: intent.reference,
		bank_details: {
			account_number: va.accountNumber,
			bank_name: va.bankName,
			// Recipient label: keep it minimal; FLW returns the actual
			// holder name from the customer record on the payer's side.
			account_name: 'TokenKrafter',
			amount_ngn: ngnWhole,
			reference: intent.reference,
			expires_at: va.expiresAt ?? null,
		},
	});
};
