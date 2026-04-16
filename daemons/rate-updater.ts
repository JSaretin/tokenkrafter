/**
 * Exchange Rate Cron Ping — pings POST /api/rates/refresh every 15 min.
 * The server does the actual fetching and DB update.
 *
 * Env vars:
 *   API_BASE_URL       — Platform URL (e.g. https://tokenkrafter.com)
 *   TX_CONFIRM_SECRET  — Auth token
 *   RATE_INTERVAL      — Poll interval in seconds (default 900 = 15 min)
 */

const API_BASE = process.env.API_BASE_URL || 'http://localhost:5173';
const SECRET = process.env.TX_CONFIRM_SECRET || process.env.SYNC_SECRET || '';
const INTERVAL = parseInt(process.env.RATE_INTERVAL || '900') * 1000;

if (!SECRET) {
	console.error('❌ TX_CONFIRM_SECRET or SYNC_SECRET required');
	process.exit(1);
}

console.log(`[rate-cron] Pinging ${API_BASE}/api/rates/refresh every ${INTERVAL / 1000}s`);

async function ping() {
	const ts = new Date().toISOString().slice(11, 19);
	try {
		const res = await fetch(`${API_BASE}/api/rates/refresh`, {
			method: 'POST',
			headers: { 'Authorization': `Bearer ${SECRET}` },
		});
		if (res.ok) {
			const data = await res.json();
			const rates = data.rates || {};
			const rateStr = Object.entries(rates).map(([k, v]) => `${k}=${v}`).join(' ');
			console.log(`[${ts}] ✓ ${rateStr}`);
		} else {
			const text = await res.text().catch(() => '');
			console.error(`[${ts}] ✗ ${res.status}: ${text.slice(0, 150)}`);
		}
	} catch (e: any) {
		console.error(`[${ts}] ✗ ${e.message}`);
	}
}

ping();
setInterval(ping, INTERVAL);
