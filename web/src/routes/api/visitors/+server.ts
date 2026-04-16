import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

// GET /api/visitors — returns current active visitor count
export const GET: RequestHandler = async () => {
	const { data, error: dbError } = await supabaseAdmin
		.from('site_visitors')
		.select('*')
		.limit(1)
		.single();

	if (dbError) {
		// If table is empty, return simulated data
		return json(generateVisitorData());
	}

	// If data is stale (>2 min old), generate fresh numbers
	const updatedAt = new Date(data.updated_at).getTime();
	const now = Date.now();
	if (now - updatedAt > 120_000) {
		const fresh = generateVisitorData();
		// Update in background
		await supabaseAdmin
			.from('site_visitors')
			.update({ ...fresh, updated_at: new Date().toISOString() })
			.eq('id', data.id);
		return json(fresh);
	}

	return json({
		total_visitors: data.total_visitors,
		browsing: data.browsing,
		creating: data.creating,
		investing: data.investing,
		updated_at: data.updated_at
	});
};


function generateVisitorData() {
	// Time-aware: more visitors during Nigerian business hours (8 AM - 10 PM WAT = UTC+1)
	const hour = new Date().getUTCHours() + 1; // WAT = UTC+1
	const isBusinessHours = hour >= 8 && hour <= 22;
	const isPeakHours = hour >= 10 && hour <= 20;

	const base = isPeakHours ? 800 : isBusinessHours ? 500 : 200;
	const variance = Math.floor(Math.random() * 300) - 150;
	const total = Math.max(100, base + variance);

	// Distribution: ~45% browsing, ~25% creating, ~30% investing
	const browsing = Math.floor(total * (0.40 + Math.random() * 0.10));
	const creating = Math.floor(total * (0.20 + Math.random() * 0.10));
	const investing = total - browsing - creating;

	return {
		total_visitors: total,
		browsing,
		creating,
		investing,
		updated_at: new Date().toISOString()
	};
}
