import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { isDaemonAuth } from '$lib/daemonAuth';

/**
 * PATCH /api/created-tokens/safu — batch update SAFU badge columns.
 * Called by: safu-indexer (bulk sweep) + ws-indexer (single-token recheck).
 * Auth: SYNC_SECRET bearer token (daemon only).
 *
 * Body: { tokens: [{ address, chain_id, is_safu, has_liquidity, lp_burned,
 *         lp_burned_pct, tax_ceiling_locked, owner_renounced, trading_enabled,
 *         buy_tax_bps, sell_tax_bps }] }
 *
 * Also accepts POST with the same body for ws-indexer compatibility.
 */

async function handleUpdate(request: Request) {
	if (!isDaemonAuth(request)) return error(401, 'Unauthorized');

	const body = await request.json();
	const tokens: any[] = body.tokens || (body.address ? [body] : []);

	if (tokens.length === 0) return error(400, 'No tokens provided');

	let updated = 0;
	const errors: string[] = [];

	for (const t of tokens) {
		if (!t.address || !t.chain_id) {
			errors.push(`Missing address or chain_id`);
			continue;
		}

		const row: Record<string, any> = {
			safu_checked_at: new Date().toISOString(),
		};

		// Only set fields that are explicitly provided (don't null out missing ones)
		if (t.is_safu !== undefined) row.is_safu = t.is_safu;
		if (t.has_liquidity !== undefined) row.has_liquidity = t.has_liquidity;
		if (t.lp_burned !== undefined) row.lp_burned = t.lp_burned;
		if (t.lp_burned_pct !== undefined) row.lp_burned_pct = t.lp_burned_pct;
		if (t.tax_ceiling_locked !== undefined) row.tax_ceiling_locked = t.tax_ceiling_locked;
		if (t.owner_renounced !== undefined) row.owner_renounced = t.owner_renounced;
		if (t.trading_enabled !== undefined) row.trading_enabled = t.trading_enabled;
		if (t.buy_tax_bps !== undefined) row.buy_tax_bps = t.buy_tax_bps;
		if (t.sell_tax_bps !== undefined) row.sell_tax_bps = t.sell_tax_bps;

		// A mintable token with a renounced owner can never mint again —
		// clear is_mintable so the UI doesn't show a misleading "Mintable" badge.
		if (t.owner_renounced === true) row.is_mintable = false;

		const { error: dbErr } = await supabaseAdmin
			.from('created_tokens')
			.update(row)
			.eq('address', t.address.toLowerCase())
			.eq('chain_id', t.chain_id);

		if (dbErr) {
			errors.push(`${t.address}: ${dbErr.message}`);
		} else {
			updated++;
		}
	}

	return json({ updated, errors: errors.length > 0 ? errors : undefined });
}

export const PATCH: RequestHandler = async ({ request }) => handleUpdate(request);
export const POST: RequestHandler = async ({ request }) => handleUpdate(request);
