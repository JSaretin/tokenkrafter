import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

// GET /api/platform-stats?chain_id=56&days=30
export const GET: RequestHandler = async ({ url }) => {
	const chainId = parseInt(url.searchParams.get('chain_id') || '56');
	const days = parseInt(url.searchParams.get('days') || '30');

	const fromDate = new Date();
	fromDate.setDate(fromDate.getDate() - days);

	// Daily stats
	const { data: dailyStats, error: statsError } = await supabaseAdmin
		.from('platform_stats')
		.select('*')
		.eq('chain_id', chainId)
		.gte('stat_date', fromDate.toISOString().split('T')[0])
		.order('stat_date', { ascending: true });

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

	// Created tokens count
	const { count: tokenCount } = await supabaseAdmin
		.from('created_tokens')
		.select('*', { count: 'exact', head: true })
		.eq('chain_id', chainId);

	// Active visitors
	const { data: visitors } = await supabaseAdmin
		.from('site_visitors')
		.select('*')
		.limit(1)
		.single();

	return json({
		daily: dailyStats || [],
		totals: {
			...totals,
			total_tokens: tokenCount || 0
		},
		visitors: visitors || { total_visitors: 0, browsing: 0, creating: 0, investing: 0 }
	});
};
