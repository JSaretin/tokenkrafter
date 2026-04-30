/**
 * Server-side alert helpers. Used by /api/alert (centralized fanout
 * called from daemons) and direct in-process callers (e.g. on-ramp
 * intent creation, where we want to ping ourselves without an extra
 * HTTP hop).
 *
 * Each helper is fire-and-forget — never throws, returns boolean for
 * the caller's logging convenience. A failed alert must not block the
 * critical path that triggered it.
 */
import { env } from '$env/dynamic/private';

export async function sendTelegram(title: string, message: string): Promise<boolean> {
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
