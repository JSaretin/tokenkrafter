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

	// Send as plain text, not Markdown. We don't use any Markdown
	// formatting (no *bold*, _italic_, code, or links) in any alert
	// across the codebase, but parse_mode='Markdown' was failing
	// intermittently on legitimate messages — Telegram's legacy
	// Markdown parser chokes on stray `_` / `*` / `[` characters in
	// values it would otherwise accept (e.g. an account name or
	// reference with an underscore). Plain text removes the failure
	// surface entirely.
	try {
		const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text: `${title}\n${message}`,
			}),
		});
		const data = await res.json();
		if (data.ok === true) return true;
		// Non-ok response (rate limit, bad chat id, parse error, etc.)
		// used to be silently swallowed — leave a server-side trail so
		// the next outage is debuggable.
		console.warn(
			`[alert] Telegram non-ok: code=${data.error_code} desc=${String(data.description ?? '').slice(0, 120)}`,
		);
		return false;
	} catch (e: any) {
		console.error('[alert] Telegram failed:', e.message?.slice(0, 80));
		return false;
	}
}
