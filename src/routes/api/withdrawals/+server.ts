import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { encrypt, decrypt } from '$lib/crypto';
import { recoverWallet, isAdminWallet } from '$lib/auth';

// GET /api/withdrawals?wallet=0x...&status=pending
// Auth: wallet session required. Non-admin callers can only see their own withdrawals.
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.wallet) return error(401, 'Wallet authentication required');

	const wallet = url.searchParams.get('wallet');
	const status = url.searchParams.get('status');
	const limit = parseInt(url.searchParams.get('limit') || '50');
	const isAdmin = locals.isAdmin || isAdminWallet(locals.wallet);

	let query = supabaseAdmin
		.from('withdrawal_requests')
		.select('*')
		.order('created_at', { ascending: false })
		.limit(limit);

	if (isAdmin) {
		// Admin can filter by any wallet, or see all
		if (wallet) query = query.eq('wallet_address', wallet.toLowerCase());
	} else {
		// Non-admin: always filter to own withdrawals only
		query = query.eq('wallet_address', locals.wallet);
	}
	if (status) query = query.eq('status', status);

	const { data, error: dbErr } = await query;
	if (dbErr) {
		console.error('[withdrawals GET] DB error:', dbErr.message);
		return error(500, 'Failed to fetch withdrawals');
	}

	// Decrypt payment_details for the requester
	const rows = data || [];
	for (const row of rows) {
		if (row.payment_details && typeof row.payment_details === 'string') {
			try { row.payment_details = await decrypt(row.payment_details); } catch (e) { console.error('[withdrawals GET] Decrypt failed for row', row.id, ':', (e as any)?.message); row.payment_details = {}; }
		}
	}

	return json(rows);
};

// POST /api/withdrawals — Step 1: save signed payment details (before on-chain trade)
// Auth: wallet session (set by hooks.server.ts on first signature)
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.wallet) return error(401, 'Wallet authentication required');

	const body = await request.json();
	const walletAddress = locals.wallet;

	const row = {
		chain_id: body.chain_id,
		wallet_address: walletAddress,
		token_in: (body.token_in || '').toLowerCase(),
		token_in_symbol: body.token_in_symbol || '',
		gross_amount: body.gross_amount || '0',
		fee: body.fee || '0',
		net_amount: body.net_amount || '0',
		payment_method: body.payment_method || 'bank',
		payment_details: await encrypt(body.payment_details || {}),
		status: 'awaiting_trade'
	};

	const { data, error: dbErr } = await supabaseAdmin
		.from('withdrawal_requests')
		.insert(row)
		.select()
		.single();

	if (dbErr) {
		console.error('[withdrawals POST] DB error:', dbErr.message);
		return error(500, 'Failed to create withdrawal');
	}

	return json(data);
};

// PATCH /api/withdrawals — admin-only status updates
// Auth: admin session (set by hooks.server.ts)
export const PATCH: RequestHandler = async ({ request, locals }) => {
	if (!locals.isAdmin) return error(401, 'Admin access required');

	const body = await request.json();
	const { id, status: newStatus, admin_note } = body;

	if (!id) return error(400, 'id required');

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

	if (dbErr) {
		console.error('[withdrawals PATCH] DB error:', dbErr.message);
		return error(500, 'Failed to update withdrawal');
	}

	return json(data);
};
