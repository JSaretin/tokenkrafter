import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

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

// POST /api/withdrawals — create withdrawal request (after on-chain deposit)
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();

	const row = {
		withdraw_id: body.withdraw_id,
		chain_id: body.chain_id,
		wallet_address: (body.wallet_address || '').toLowerCase(),
		token_in: (body.token_in || '').toLowerCase(),
		token_in_symbol: body.token_in_symbol || '',
		gross_amount: body.gross_amount || '0',
		fee: body.fee || '0',
		net_amount: body.net_amount || '0',
		payment_method: body.payment_method || 'bank',
		payment_details: body.payment_details || {},
		status: 'pending',
		tx_hash: body.tx_hash || null
	};

	const { data, error: dbErr } = await supabaseAdmin
		.from('withdrawal_requests')
		.upsert(row, { onConflict: 'withdraw_id,chain_id' })
		.select()
		.single();

	if (dbErr) return error(500, dbErr.message);

	return json(data);
};

// PATCH /api/withdrawals — admin update status
export const PATCH: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { id, status: newStatus, admin_note } = body;

	if (!id || !newStatus) return error(400, 'id and status required');
	if (!['confirmed', 'cancelled'].includes(newStatus)) return error(400, 'Invalid status');

	const update: any = { status: newStatus, updated_at: new Date().toISOString() };
	if (newStatus === 'confirmed') update.confirmed_at = new Date().toISOString();
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
