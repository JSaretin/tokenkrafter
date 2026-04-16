import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { supabaseAdmin } from '$lib/supabaseServer';

/**
 * POST /api/alert — centralized alert fanout
 *
 * Dispatches alerts to configured channels: Telegram, email (future),
 * webhooks (future), user notifications (future).
 *
 * Auth: TX_CONFIRM_SECRET or SYNC_SECRET bearer token.
 *
 * Body: {
 *   type: 'payment' | 'launch' | 'system' | 'graduation' | 'refund',
 *   title: string,
 *   message: string,
 *   channels?: ('telegram' | 'email' | 'webhook')[],  // default: all configured
 *   data?: Record<string, any>,                        // structured payload for templates
 * }
 */

function authenticate(request: Request): boolean {
	const auth = request.headers.get('authorization');
	return !!(env.TX_CONFIRM_SECRET && auth === `Bearer ${env.TX_CONFIRM_SECRET}`) ||
		!!(env.SYNC_SECRET && auth === `Bearer ${env.SYNC_SECRET}`);
}

async function sendTelegram(title: string, message: string): Promise<boolean> {
	const token = env.TELEGRAM_BOT_TOKEN;
	const chatId = env.TELEGRAM_CHANNEL_ID;
	if (!token || !chatId) return false;

	try {
		const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text: `${title}\n${message}`,
				parse_mode: 'Markdown',
			}),
		});
		const data = await res.json();
		return data.ok === true;
	} catch (e: any) {
		console.error('[alert] Telegram failed:', e.message?.slice(0, 80));
		return false;
	}
}

// Future: email via Resend/SES/SMTP
// async function sendEmail(to: string, title: string, message: string): Promise<boolean> { ... }

// Future: generic webhook
// async function sendWebhook(url: string, payload: any): Promise<boolean> { ... }

export const POST: RequestHandler = async ({ request }) => {
	if (!authenticate(request)) return error(401, 'Unauthorized');

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
