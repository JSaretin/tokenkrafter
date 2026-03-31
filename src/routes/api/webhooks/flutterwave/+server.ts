import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { supabaseAdmin } from '$lib/supabaseServer';
import crypto from 'crypto';

// POST /api/webhooks/flutterwave — handle transfer status updates
export const POST: RequestHandler = async ({ request }) => {
	// Verify webhook signature using encryption key
	const signature = request.headers.get('verif-hash');
	const webhookSecret = env.FLUTTERWAVE_WEBHOOK_SECRET || env.FLUTTERWAVE_ENCRYPTION_KEY;

	if (webhookSecret && signature !== webhookSecret) {
		return json({ status: 'error', message: 'Invalid signature' }, { status: 401 });
	}

	const body = await request.json();
	const event = body.event;
	const data = body.data;

	if (!event || !data) {
		return json({ status: 'error', message: 'Invalid payload' }, { status: 400 });
	}

	console.log(`[Flutterwave Webhook] ${event}:`, data.reference, data.status);

	// Handle transfer events
	if (event === 'transfer.completed') {
		const reference = data.reference; // e.g. "TKR-withdraw-123"
		const status = data.status; // "SUCCESSFUL", "FAILED"

		if (!reference) {
			return json({ status: 'ok' });
		}

		// Extract withdraw_id from reference (format: TKR-chain-withdrawId)
		const match = reference.match(/^TKR-(\d+)-(\d+)$/);
		if (!match) {
			return json({ status: 'ok' });
		}

		const chainId = parseInt(match[1]);
		const withdrawId = parseInt(match[2]);

		const newStatus = status === 'SUCCESSFUL' ? 'confirmed' : 'failed';

		// Update withdrawal request in DB
		const { error: dbErr } = await supabaseAdmin
			.from('withdrawal_requests')
			.update({
				status: newStatus,
				admin_note: `Flutterwave transfer ${status}. ID: ${data.id}`,
				confirmed_at: newStatus === 'confirmed' ? new Date().toISOString() : null,
				updated_at: new Date().toISOString()
			})
			.eq('withdraw_id', withdrawId)
			.eq('chain_id', chainId);

		if (dbErr) {
			console.error('[Flutterwave Webhook] DB update failed:', dbErr.message);
		}

		// TODO: Auto-call contract.confirm() here when we add the server-side signer
	}

	return json({ status: 'ok' });
};
