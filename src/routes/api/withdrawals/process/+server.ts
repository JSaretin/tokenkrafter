import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { initiateTransfer, resolveAccount } from '$lib/flutterwave';

// POST /api/withdrawals/process — initiate Flutterwave transfer for a pending withdrawal
// Called by admin dashboard or automation
export const POST: RequestHandler = async ({ request }) => {
	const { withdrawal_id, naira_rate } = await request.json();

	if (!withdrawal_id) return error(400, 'withdrawal_id required');

	// Get withdrawal from DB
	const { data: withdrawal, error: dbErr } = await supabaseAdmin
		.from('withdrawal_requests')
		.select('*')
		.eq('id', withdrawal_id)
		.single();

	if (dbErr || !withdrawal) return error(404, 'Withdrawal not found');
	if (withdrawal.status !== 'pending') return error(400, 'Withdrawal not pending');
	if (withdrawal.payment_method !== 'bank') return error(400, 'Only bank transfers are auto-processed');

	const details = withdrawal.payment_details;
	if (!details?.bank_code || !details?.account) {
		return error(400, 'Missing bank details');
	}

	// Calculate NGN amount (net USDT × naira rate)
	const netUsdt = parseFloat(withdrawal.net_amount) / 1e6; // USDT has 6 decimals
	const rate = naira_rate || 1600; // Default rate, should be passed by admin
	const ngnAmount = Math.floor(netUsdt * rate);

	if (ngnAmount <= 0) return error(400, 'Amount too small');

	// Initiate transfer
	try {
		const reference = `TKR-${withdrawal.chain_id}-${withdrawal.withdraw_id}`;

		const result = await initiateTransfer({
			accountNumber: details.account,
			bankCode: details.bank_code,
			amount: ngnAmount,
			narration: `TokenKrafter withdrawal #${withdrawal.withdraw_id}`,
			reference,
			accountName: details.holder
		});

		if (!result.success) {
			return json({ success: false, error: result.error }, { status: 500 });
		}

		// Update DB with transfer info
		await supabaseAdmin
			.from('withdrawal_requests')
			.update({
				status: 'processing',
				admin_note: `Flutterwave transfer initiated. ID: ${result.transferId}, NGN ${ngnAmount} @ rate ${rate}`,
				updated_at: new Date().toISOString()
			})
			.eq('id', withdrawal_id);

		return json({
			success: true,
			transfer_id: result.transferId,
			ngn_amount: ngnAmount,
			rate,
			reference
		});
	} catch (e: any) {
		return json({ success: false, error: e.message || 'Transfer failed' }, { status: 500 });
	}
};
