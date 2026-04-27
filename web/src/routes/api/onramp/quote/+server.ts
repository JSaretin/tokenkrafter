/**
 * POST /api/onramp/quote
 * Body: { ngn_amount_kobo: integer, chain_id?: number }
 * Returns: OnrampQuote (reference, nonce, usdt_amount_wei, rate_x100, expires_at)
 *
 * Mints a fresh reference + nonce, locks the rate at quote time, and
 * persists an intent row in 'quoted' state. Frontend signs the typed
 * data using these values and POSTs to /api/onramp/intent.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { randomBytes } from 'crypto';
import { supabaseAdmin } from '$lib/supabaseServer';

const MIN_NGN_KOBO = 50_000;        // ₦500 floor
const MAX_NGN_KOBO = 5_000_000;     // ₦50,000 cap (raise once KYC tier ladder ships)
const QUOTE_TTL_SECONDS = 900;       // 15 min

async function loadNgnRate(): Promise<number | null> {
	// Mirror trade/+page.server.ts rate logic, but skip the spread —
	// per spec the on-ramp uses the raw db rate. Override still wins
	// if explicitly set in platform_config.rate_override.
	const [{ data: settings }, { data: override }] = await Promise.all([
		supabaseAdmin.from('platform_config').select('value').eq('key', 'exchange_rates').single(),
		supabaseAdmin.from('platform_config').select('value').eq('key', 'rate_override').single(),
	]);
	const overridden = override?.value?.NGN;
	if (typeof overridden === 'number' && overridden > 0) return overridden;
	const raw = settings?.value?.rates?.NGN;
	if (typeof raw === 'number' && raw > 0) return raw;
	return null;
}

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	const ngn_amount_kobo = Number(body?.ngn_amount_kobo);
	const chain_id = Number(body?.chain_id ?? 56);

	if (!Number.isInteger(ngn_amount_kobo)) return error(400, 'ngn_amount_kobo must be an integer');
	if (ngn_amount_kobo < MIN_NGN_KOBO) return error(400, `Minimum on-ramp is ₦${MIN_NGN_KOBO / 100}`);
	if (ngn_amount_kobo > MAX_NGN_KOBO) return error(400, `Maximum on-ramp is ₦${MAX_NGN_KOBO / 100}`);

	const ngnRate = await loadNgnRate();
	if (!ngnRate) return error(503, 'Exchange rate unavailable');
	const rate_x100 = Math.round(ngnRate * 100);

	// USDT (18-decimal) wei = (ngn_amount_kobo × 10^18) / (rate × 100)
	// All bigint to avoid float drift on small amounts.
	const usdt_amount_wei = (BigInt(ngn_amount_kobo) * 10n ** 18n) / BigInt(rate_x100);
	if (usdt_amount_wei <= 0n) return error(400, 'Amount too small to quote');

	const reference = 'TKO-' + randomBytes(6).toString('hex').toUpperCase();
	const nonce = '0x' + randomBytes(32).toString('hex');
	const now = Math.floor(Date.now() / 1000);
	const expires_at = now + QUOTE_TTL_SECONDS;

	const { error: dbErr } = await supabaseAdmin.from('onramp_intents').insert({
		reference,
		nonce,
		chain_id,
		ngn_amount_kobo,
		usdt_amount_wei: usdt_amount_wei.toString(),
		rate_x100,
		expires_at: new Date(expires_at * 1000).toISOString(),
		status: 'quoted',
	});
	if (dbErr) {
		console.error('[onramp.quote] insert failed:', dbErr.message);
		return error(500, 'Failed to issue quote');
	}

	return json({
		reference,
		nonce,
		chain_id,
		ngn_amount_kobo,
		usdt_amount_wei: usdt_amount_wei.toString(),
		rate_x100,
		expires_at,
	});
};
