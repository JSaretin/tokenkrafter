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

const QUOTE_TTL_SECONDS = 900;       // 15 min

// Defaults — every value is overrideable from `platform_config.rate_override`.
//   rate_override.spread_bps         — buy/sell rate spread, applied symmetrically
//   rate_override.onramp_fee_bps     — platform on-ramp fee (covers FLW + margin)
//   rate_override.onramp_min_kobo    — minimum on-ramp NGN amount in kobo
//   rate_override.NGN                — hard rate override (bypasses spread)
const DEFAULT_SPREAD_BPS = 30;
const DEFAULT_ONRAMP_FEE_BPS = 250;
const DEFAULT_ONRAMP_MIN_KOBO = 50_000; // ₦500

async function loadOnrampConfig(): Promise<
	{ rate: number; feeBps: number; minKobo: number } | null
> {
	const [{ data: settings }, { data: override }] = await Promise.all([
		supabaseAdmin.from('platform_config').select('value').eq('key', 'exchange_rates').single(),
		supabaseAdmin.from('platform_config').select('value').eq('key', 'rate_override').single(),
	]);
	const overridden = override?.value?.NGN;
	const raw = settings?.value?.rates?.NGN;
	const feeBps = Number(override?.value?.onramp_fee_bps ?? DEFAULT_ONRAMP_FEE_BPS);
	const minKobo = Math.max(0, Number(override?.value?.onramp_min_kobo ?? DEFAULT_ONRAMP_MIN_KOBO));
	const spreadBps = Number(override?.value?.spread_bps ?? DEFAULT_SPREAD_BPS);
	if (typeof overridden === 'number' && overridden > 0) {
		return { rate: overridden, feeBps, minKobo };
	}
	if (typeof raw !== 'number' || raw <= 0) return null;
	return { rate: raw * (1 + spreadBps / 10000), feeBps, minKobo };
}

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	const ngn_amount_kobo = Number(body?.ngn_amount_kobo);
	const chain_id = Number(body?.chain_id ?? 56);

	if (!Number.isInteger(ngn_amount_kobo)) return error(400, 'ngn_amount_kobo must be an integer');

	const cfg = await loadOnrampConfig();
	if (!cfg) return error(503, 'Exchange rate unavailable');
	if (ngn_amount_kobo < cfg.minKobo) {
		return error(400, `Minimum on-ramp is ₦${(cfg.minKobo / 100).toLocaleString()}`);
	}
	const rate_x100 = Math.round(cfg.rate * 100);
	const feeBps = cfg.feeBps;

	// Gross USDT from FX conversion at the locked rate, then deduct the
	// platform on-ramp fee. The user signs (and ultimately receives) the
	// NET amount; gross + fee_bps are returned alongside for transparent
	// breakdown in the review modal.
	const usdt_gross_wei = (BigInt(ngn_amount_kobo) * 10n ** 18n) / BigInt(rate_x100);
	const usdt_amount_wei = (usdt_gross_wei * BigInt(10000 - feeBps)) / 10000n;
	if (usdt_amount_wei <= 0n) return error(400, 'Amount too small to quote');

	// `reference` doubles as Flutterwave's NUBAN-displayed account-name
	// (sending banks query NIBSS with the VA number and FLW responds with
	// this string). Branding it `TokenKrafter-XXXXXX` so payers see the
	// company name rather than a cryptic ref. The short `TKO-XXXXXX` form
	// still appears as the `narration` for our own logs / statements.
	const refSuffix = randomBytes(3).toString('hex').toUpperCase();
	const reference = `TokenKrafter-${refSuffix}`;
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
