import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { supabaseAdmin } from '$lib/supabaseServer';
import { isDaemonAuth } from '$lib/daemonAuth';
import { sendTelegram } from '$lib/alerts';

/**
 * POST /api/alert — centralized alert fanout
 *
 * Dispatches alerts to configured channels: Telegram, email (future),
 * webhooks (future), user notifications (future).
 *
 * Auth: daemon-only (isDaemonAuth — TX_CONFIRM_SECRET or SYNC_SECRET).
 *
 * Body: {
 *   type: 'payment' | 'launch' | 'system' | 'graduation' | 'refund',
 *   title: string,
 *   message: string,
 *   channels?: ('telegram' | 'email' | 'webhook')[],  // default: all configured
 *   data?: Record<string, any>,                        // structured payload for templates
 * }
 */

// Future: email via Resend/SES/SMTP
// async function sendEmail(to: string, title: string, message: string): Promise<boolean> { ... }

// Future: generic webhook
// async function sendWebhook(url: string, payload: any): Promise<boolean> { ... }

export const POST: RequestHandler = async ({ request }) => {
	if (!isDaemonAuth(request)) return error(401, 'Unauthorized');

	const body = await request.json();
	const { type = 'system', title = '', message = '', channels, data } = body;

	if (!title && !message) return error(400, 'title or message required');

	const results: Record<string, boolean> = {};
	const targetChannels: string[] = channels || ['telegram'];

	// Telegram
	if (targetChannels.includes('telegram')) {
		results.telegram = await sendTelegram(
			title || type.toUpperCase(),
			message,
		);
	}

	// Email (future)
	// if (targetChannels.includes('email') && data?.email) {
	//   results.email = await sendEmail(data.email, title, message);
	// }

	// Webhook (future)
	// if (targetChannels.includes('webhook') && env.ALERT_WEBHOOK) {
	//   results.webhook = await sendWebhook(env.ALERT_WEBHOOK, { type, title, message, data });
	// }

	return json({ sent: results });
};
