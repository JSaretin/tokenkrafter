import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { ethers } from 'ethers';

// GET /api/withdrawals?wallet=0x...&status=pending
export const GET: RequestHandler = async ({ url }) => {
	const wallet = url.searchParams.get('wallet');
	const status = url.searchParams.get('status');
	const limit = parseInt(url.searchParams.get('limit') || '50');

	let query = supabaseAdmin
		.from('withdrawal_requests')
		.select('*')
		.order('created_at', { ascending: false })
		.limit(limit);

	if (wallet) query = query.eq('wallet_address', wallet.toLowerCase());
	if (status) query = query.eq('status', status);

	const { data, error: dbErr } = await query;
	if (dbErr) return error(500, dbErr.message);

	return json(data || []);
};

// POST /api/withdrawals — Step 1: save signed payment details (before on-chain trade)
// Requires wallet signature to prove ownership of bank details
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();

	// Require signature
	if (!body.signature || !body.signed_message) {
		return error(400, 'Signature required');
	}

	const walletAddress = (body.wallet_address || '').toLowerCase();

	// Verify wallet signature
	try {
		const recovered = ethers.verifyMessage(body.signed_message, body.signature);
		if (recovered.toLowerCase() !== walletAddress) {
			return error(403, 'Signature does not match wallet address');
		}
		// Verify timestamp freshness (5 min window)
		const tsMatch = body.signed_message.match(/Timestamp: (\d+)/);
		if (tsMatch) {
			const ts = parseInt(tsMatch[1]);
			if (Date.now() - ts > 5 * 60 * 1000) {
				return error(400, 'Signature expired');
			}
		}
	} catch {
		return error(400, 'Invalid signature');
	}

	// Rate limit: max 3 awaiting_trade per wallet
	const { count } = await supabaseAdmin
		.from('withdrawal_requests')
		.select('id', { count: 'exact', head: true })
		.eq('wallet_address', walletAddress)
		.eq('status', 'awaiting_trade');

	if ((count ?? 0) >= 3) {
		return error(429, 'Too many pending requests. Complete or cancel existing ones first.');
	}

	const row = {
		chain_id: body.chain_id,
		wallet_address: walletAddress,
		token_in: (body.token_in || '').toLowerCase(),
		token_in_symbol: body.token_in_symbol || '',
		gross_amount: body.gross_amount || '0',
		fee: body.fee || '0',
		net_amount: body.net_amount || '0',
		payment_method: body.payment_method || 'bank',
		payment_details: body.payment_details || {},
		status: 'awaiting_trade',
		withdraw_id: 0
	};

	const { data, error: dbErr } = await supabaseAdmin
		.from('withdrawal_requests')
		.insert(row)
		.select()
		.single();

	if (dbErr) return error(500, dbErr.message);

	return json(data);
};

// PATCH /api/withdrawals — admin-only status updates
// The verify endpoint handles post-trade updates (awaiting_trade → pending)
export const PATCH: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { id, status: newStatus, admin_note } = body;

	if (!id) return error(400, 'id required');

	// Only allow admin status transitions
	if (newStatus) {
		if (!['confirmed', 'cancelled'].includes(newStatus)) {
			return error(400, 'Invalid status. Only confirmed/cancelled allowed.');
		}
	}

	const update: any = { updated_at: new Date().toISOString() };
	if (newStatus) {
		update.status = newStatus;
		if (newStatus === 'confirmed') update.confirmed_at = new Date().toISOString();
	}
	if (admin_note) update.admin_note = admin_note;

	const { data, error: dbErr } = await supabaseAdmin
		.from('withdrawal_requests')
		.update(update)
		.eq('id', id)
		.select()
		.single();

	if (dbErr) return error(500, dbErr.message);

	return json(data);
};
