import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

// GET /api/platform-stats?chain_id=56&days=30
// GET /api/platform-stats?chain_id=56&from=2026-01-01&to=2026-03-31
//
// Accepts either:
//   - `days=N`  — last N days, trailing window (default 30)
//   - `from=YYYY-MM-DD` + optional `to=YYYY-MM-DD` — explicit date range
//
// Explicit dates take precedence when both `from` and `days` are provided.
// `to` defaults to today when omitted.
export const GET: RequestHandler = async ({ url }) => {
	const chainId = parseInt(url.searchParams.get('chain_id') || '56');

	const fromParam = url.searchParams.get('from');
	const toParam = url.searchParams.get('to');

	let fromDateIso: string;
	let toDateIso: string | null = null;

	if (fromParam) {
		// Validate YYYY-MM-DD shape — SQL date column, no time component.
		if (!/^\d{4}-\d{2}-\d{2}$/.test(fromParam)) return error(400, 'from must be YYYY-MM-DD');
		fromDateIso = fromParam;
		if (toParam) {
			if (!/^\d{4}-\d{2}-\d{2}$/.test(toParam)) return error(400, 'to must be YYYY-MM-DD');
			toDateIso = toParam;
		}
	} else {
		const days = parseInt(url.searchParams.get('days') || '30');
		const d = new Date();
		d.setDate(d.getDate() - days);
		fromDateIso = d.toISOString().split('T')[0];
	}

	// Daily stats
	let query = supabaseAdmin
		.from('platform_stats')
		.select('*')
		.eq('chain_id', chainId)
		.gte('stat_date', fromDateIso)
		.order('stat_date', { ascending: true });

	if (toDateIso) {
		query = query.lte('stat_date', toDateIso);
	}

	const { data: dailyStats, error: statsError } = await query;

	if (statsError) {
		return error(500, statsError.message);
	}

	// Aggregate totals
	const totals = {
		tokens_created: 0,
		partner_tokens_created: 0,
		creation_fees_usdt: 0,
		launches_created: 0,
		launches_graduated: 0,
		total_raised_usdt: 0,
		launch_fees_usdt: 0,
		tax_revenue_usdt: 0
	};

	for (const day of (dailyStats || [])) {
		totals.tokens_created += day.tokens_created;
		totals.partner_tokens_created += day.partner_tokens_created;
		totals.creation_fees_usdt += parseFloat(day.creation_fees_usdt);
		totals.launches_created += day.launches_created;
		totals.launches_graduated += day.launches_graduated;
		totals.total_raised_usdt += parseFloat(day.total_raised_usdt);
		totals.launch_fees_usdt += parseFloat(day.launch_fees_usdt);
		totals.tax_revenue_usdt += parseFloat(day.tax_revenue_usdt);
	}

	// Created tokens count — respects the date range when explicit `from`
	// is given (so the dashboard's "tokens in window" KPI matches the
	// daily chart). When no `from` is given we still return the all-time
	// total for backwards compat with the default `days=30` path.
	let countQuery = supabaseAdmin
		.from('created_tokens')
		.select('*', { count: 'exact', head: true })
		.eq('chain_id', chainId);
	if (fromParam) {
		countQuery = countQuery.gte('created_at', fromDateIso);
		if (toDateIso) {
			// created_at is timestamptz — include the full end day by using
			// the exclusive upper bound of the next calendar day.
			const endDate = new Date(toDateIso);
			endDate.setDate(endDate.getDate() + 1);
			countQuery = countQuery.lt('created_at', endDate.toISOString().split('T')[0]);
		}
	}
	const { count: tokenCount } = await countQuery;

	return json({
		daily: dailyStats || [],
		totals: {
			...totals,
			total_tokens: tokenCount || 0
		}
	});
};
