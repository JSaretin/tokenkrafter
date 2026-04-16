import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

// GET /api/launches/stats — aggregate stats for the homepage
export const GET: RequestHandler = async () => {
	const { data, error: dbError } = await supabaseAdmin
		.from('launches')
		.select('state, total_base_raised, hard_cap, usdt_decimals');

	if (dbError) {
		return error(500, dbError.message);
	}

	const launches = data || [];
	let totalLaunches = launches.length;
	let activeLaunches = 0;
	let graduatedLaunches = 0;
	let totalRaisedRaw = 0n;

	for (const l of launches) {
		if (l.state === 1) activeLaunches++;
		if (l.state === 2) graduatedLaunches++;
		// Normalize raised amounts to a common decimal (18) for summing
		const raised = BigInt(l.total_base_raised || '0');
		const decimals = l.usdt_decimals ?? 18;
		if (decimals === 18) {
			totalRaisedRaw += raised;
		} else {
			// Scale up to 18 decimals
			totalRaisedRaw += raised * (10n ** BigInt(18 - decimals));
		}
	}

	// Format total raised as a dollar string
	const totalRaisedFloat = Number(totalRaisedRaw) / 1e18;

	return json({
		total_launches: totalLaunches,
		active_launches: activeLaunches,
		graduated_launches: graduatedLaunches,
		total_raised_usd: totalRaisedFloat
	});
};
