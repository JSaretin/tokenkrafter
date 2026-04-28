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

// On-ramp default fee (bps). Covers Flutterwave's 1.6% inbound deposit
// fee and leaves a thin platform margin. Tunable per-deploy via
// `platform_config.rate_override.onramp_fee_bps`.
const DEFAULT_ONRAMP_FEE_BPS = 250;

async function loadRateAndFee(): Promise<{ rate: number; feeBps: number } | null> {
	// Mirrors trade/+page.server.ts but applies the spread in the BUY
	// direction (NGN paid per USDT goes UP), the inverse of off-ramp.
	// `rate_override.NGN`, when set, is treated as a hard override and
	// bypasses the spread entirely (operator decides the exact rate).
	const [{ data: settings }, { data: override }] = await Promise.all([
		supabaseAdmin.from('platform_config').select('value').eq('key', 'exchange_rates').single(),
		supabaseAdmin.from('platform_config').select('value').eq('key', 'rate_override').single(),
	]);
	const overridden = override?.value?.NGN;
	const raw = settings?.value?.rates?.NGN;
	const feeBps = Number(override?.value?.onramp_fee_bps ?? DEFAULT_ONRAMP_FEE_BPS);
	if (typeof overridden === 'number' && overridden > 0) {
		return { rate: overridden, feeBps };
	}
	if (typeof raw !== 'number' || raw <= 0) return null;
	const spreadBps = override?.value?.spread_bps ?? 30;
	return { rate: raw * (1 + spreadBps / 10000), feeBps };
}

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	const ngn_amount_kobo = Number(body?.ngn_amount_kobo);
	const chain_id = Number(body?.chain_id ?? 56);

	if (!Number.isInteger(ngn_amount_kobo)) return error(400, 'ngn_amount_kobo must be an integer');
	if (ngn_amount_kobo < MIN_NGN_KOBO) return error(400, `Minimum on-ramp is ₦${MIN_NGN_KOBO / 100}`);
	if (ngn_amount_kobo > MAX_NGN_KOBO) return error(400, `Maximum on-ramp is ₦${MAX_NGN_KOBO / 100}`);

	const rateInfo = await loadRateAndFee();
	if (!rateInfo) return error(503, 'Exchange rate unavailable');
	const rate_x100 = Math.round(rateInfo.rate * 100);
	const feeBps = rateInfo.feeBps;

	// Gross USDT from FX conversion at the locked rate, then deduct the
	// platform on-ramp fee. The user signs (and ultimately receives) the
	// NET amount; gross + fee_bps are returned alongside for transparent
	// breakdown in the review modal.
	const usdt_gross_wei = (BigInt(ngn_amount_kobo) * 10n ** 18n) / BigInt(rate_x100);
	const usdt_amount_wei = (usdt_gross_wei * BigInt(10000 - feeBps)) / 10000n;
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
		usdt_gross_wei: usdt_gross_wei.toString(),
		fee_bps: feeBps,
		rate_x100,
		expires_at,
	});
};
