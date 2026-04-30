/**
 * POST /api/onramp/quote
 * Body: { ngn_amount_kobo: integer, chain_id?: number, receiver?: address }
 * Returns: OnrampQuote (reference, nonce, usdt_amount_wei, gas_drip_wei, …)
 *
 * Mints a fresh reference + nonce, locks the rate at quote time, and
 * persists an intent row in 'quoted' state. Frontend signs the typed
 * data using these values and POSTs to /api/onramp/intent.
 *
 * Gas drip:
 *   When `receiver` is supplied AND the chain has `onramp_gas_drip` set
 *   AND the receiver's native balance is below the drip amount AND we
 *   have a fresh USD price for the native coin, the quote includes a
 *   gas drip — the receiver gets a small amount of native to spend
 *   their USDT, and the USD-equivalent is deducted from `usdt_amount_wei`
 *   so the platform doesn't eat the cost. The deduction is locked into
 *   the EIP-712 intent so the platform is contractually obligated to
 *   send the BNB once the user has paid.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { randomBytes } from 'crypto';
import { ethers } from 'ethers';
import { supabaseAdmin } from '$lib/supabaseServer';
import { fetchAndCacheNativePrice } from '$lib/cryptoRates';

const QUOTE_TTL_SECONDS = 900;       // 15 min

// Defaults — every value is overrideable from `platform_config.rate_override`.
//   rate_override.spread_bps         — buy/sell rate spread, applied symmetrically
//   rate_override.onramp_fee_bps     — platform on-ramp fee (covers FLW + margin)
//   rate_override.onramp_min_kobo    — minimum on-ramp NGN amount in kobo
//   rate_override.NGN                — hard rate override (bypasses spread)
const DEFAULT_SPREAD_BPS = 30;
const DEFAULT_ONRAMP_FEE_BPS = 250;
const DEFAULT_ONRAMP_MIN_KOBO = 50_000; // ₦500

interface OnrampConfig {
	rate: number;
	feeBps: number;
	minKobo: number;
}

async function loadOnrampConfig(): Promise<OnrampConfig | null> {
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

interface DripContext {
	dripWei: bigint;
	nativeSymbol: string;
	nativeUsd: number;
	rpc: string;
}

/**
 * Resolve the per-chain drip context: configured drip amount, native
 * coin symbol + USD price, and an HTTP RPC for balance checks. Returns
 * null if any prerequisite is missing — caller treats that as "no drip
 * for this quote".
 */
async function loadDripContext(chainId: number): Promise<DripContext | null> {
	const [{ data: networksRow }, { data: ratesRow }] = await Promise.all([
		supabaseAdmin.from('platform_config').select('value').eq('key', 'networks').single(),
		supabaseAdmin.from('platform_config').select('value').eq('key', 'exchange_rates').single(),
	]);
	const networks = (networksRow?.value as any[]) ?? [];
	const net = networks.find((n: any) => Number(n.chain_id) === chainId);
	if (!net?.rpc) return null;
	const nativeSymbol = (net.native_coin as string) || '';
	if (!nativeSymbol) return null;
	let dripWei = 0n;
	const raw = net.onramp_gas_drip;
	if (raw != null && raw !== '' && raw !== 0) {
		try {
			dripWei = ethers.parseEther(String(raw));
		} catch {
			dripWei = 0n;
		}
	}
	if (dripWei <= 0n) return null;
	let nativeUsd = Number(ratesRow?.value?.crypto?.[nativeSymbol]);
	// Self-heal: if the cached native price is missing or junk (rate
	// daemon hasn't run yet, fresh deploy, operator typo), fetch
	// CoinGecko inline and write the result back so the next quote is
	// fast. Tight timeout — we'd rather skip the drip than block the
	// quote on a slow upstream.
	if (!Number.isFinite(nativeUsd) || nativeUsd <= 0) {
		nativeUsd = await fetchAndCacheNativePrice(nativeSymbol);
	}
	if (!Number.isFinite(nativeUsd) || nativeUsd <= 0) return null;
	const rpc = (net.daemon_rpc?.startsWith('http') ? net.daemon_rpc : null) || net.rpc;
	return { dripWei, nativeSymbol, nativeUsd, rpc };
}

/**
 * Compute the drip + USDT deduction for this quote.
 *
 * Returns `{ gasDripWei, deductionWei }` where deductionWei is the
 * USDT (in wei, 18 decimals) needed to cover the drip's USD cost at
 * the locked NGN→USD rate. Returns zero-zero if the receiver already
 * has gas, the chain has no drip configured, or anything else is
 * misconfigured. This function never throws — failures degrade to "no
 * drip" so the quote still succeeds.
 */
async function resolveDrip(
	chainId: number,
	receiver: string | undefined,
): Promise<{ gasDripWei: bigint; deductionWei: bigint; symbol: string }> {
	const empty = { gasDripWei: 0n, deductionWei: 0n, symbol: '' };
	if (!receiver || !ethers.isAddress(receiver)) return empty;

	const ctx = await loadDripContext(chainId);
	if (!ctx) return empty;

	let balance: bigint;
	try {
		const provider = new ethers.JsonRpcProvider(ctx.rpc, chainId, { staticNetwork: true });
		balance = await provider.getBalance(receiver);
	} catch (e: any) {
		console.warn('[onramp.quote] balance check failed:', e?.message?.slice(0, 100));
		return empty;
	}
	if (balance >= ctx.dripWei) return empty;

	// USD cost of the drip = (dripWei / 1e18) * nativeUsd. We multiply
	// by 1_000_000 first to keep integer math, then divide back out at
	// the end — keeps precision down to 1e-6 USD.
	const usdMicros = (ctx.dripWei * BigInt(Math.round(ctx.nativeUsd * 1_000_000))) / 10n ** 18n;
	// Convert USD micros → USDT wei (18 decimals): wei = usd * 1e18 = micros * 1e12
	const deductionWei = usdMicros * 10n ** 12n;
	return { gasDripWei: ctx.dripWei, deductionWei, symbol: ctx.nativeSymbol };
}

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	const ngn_amount_kobo = Number(body?.ngn_amount_kobo);
	const chain_id = Number(body?.chain_id ?? 56);
	const receiver = typeof body?.receiver === 'string' ? body.receiver : undefined;

	if (!Number.isInteger(ngn_amount_kobo)) return error(400, 'ngn_amount_kobo must be an integer');

	const cfg = await loadOnrampConfig();
	if (!cfg) return error(503, 'Exchange rate unavailable');
	if (ngn_amount_kobo < cfg.minKobo) {
		return error(400, `Minimum on-ramp is ₦${(cfg.minKobo / 100).toLocaleString()}`);
	}
	const rate_x100 = Math.round(cfg.rate * 100);
	const feeBps = cfg.feeBps;

	// Gross USDT from FX conversion at the locked rate, then deduct the
	// platform on-ramp fee. Drip deduction (if any) comes off the net.
	const usdt_gross_wei = (BigInt(ngn_amount_kobo) * 10n ** 18n) / BigInt(rate_x100);
	const usdt_after_fee = (usdt_gross_wei * BigInt(10000 - feeBps)) / 10000n;

	const drip = await resolveDrip(chain_id, receiver);
	// Guard: if the deduction would consume the entire (or more than)
	// post-fee USDT, abandon the drip rather than letting the user
	// receive a near-zero / negative amount. They can top up later.
	let usdt_amount_wei = usdt_after_fee;
	let gas_drip_wei = drip.gasDripWei;
	let gas_drip_deduction_wei = drip.deductionWei;
	let gas_drip_symbol = drip.symbol;
	if (gas_drip_deduction_wei > 0n && gas_drip_deduction_wei < usdt_after_fee) {
		usdt_amount_wei = usdt_after_fee - gas_drip_deduction_wei;
	} else {
		gas_drip_wei = 0n;
		gas_drip_deduction_wei = 0n;
		gas_drip_symbol = '';
	}

	if (usdt_amount_wei <= 0n) return error(400, 'Amount too small to quote');

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
		gas_drip_wei: gas_drip_wei.toString(),
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
		gas_drip_wei: gas_drip_wei.toString(),
		gas_drip_usdt_deduction_wei: gas_drip_deduction_wei.toString(),
		gas_drip_symbol,
		fee_bps: feeBps,
		rate_x100,
		expires_at,
	});
};
