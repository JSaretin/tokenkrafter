import type { PageServerLoad } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

export const load: PageServerLoad = async ({ setHeaders }) => {
	setHeaders({ 'cache-control': 'public, max-age=15, s-maxage=30' });

	// Fetch launches + badges + token trust signals in parallel
	const [launchesResult, badgesResult, tokensResult] = await Promise.all([
		supabaseAdmin
			.from('launches')
			.select('*')
			.order('created_at', { ascending: false })
			.limit(100),
		supabaseAdmin
			.from('badges')
			.select('launch_address, chain_id, badge_type'),
		supabaseAdmin
			.from('created_tokens')
			.select('address, logo_url, is_safu, is_kyc, is_mintable, is_taxable, is_partner, lp_burned, tax_ceiling_locked, owner_renounced'),
	]);

	// Build badge map
	const badgeMap: Record<string, string[]> = {};
	for (const r of badgesResult.data || []) {
		const key = `${r.launch_address.toLowerCase()}-${r.chain_id}`;
		if (!badgeMap[key]) badgeMap[key] = [];
		badgeMap[key].push(r.badge_type);
	}

	// Build token trust map
	const tokenMap: Record<string, any> = {};
	for (const t of tokensResult.data || []) {
		tokenMap[t.address.toLowerCase()] = t;
	}

	// Attach badges + token data to launches
	const launches = (launchesResult.data || []).map((row: any) => {
		const key = `${(row.address || '').toLowerCase()}-${row.chain_id}`;
		const tokenAddr = (row.token_address || '').toLowerCase();
		const token = tokenMap[tokenAddr];
		return {
			...row,
			badges: badgeMap[key] || [],
			logo_url: row.logo_url || token?.logo_url || '',
			tokenTrust: token ? {
				is_safu: token.is_safu,
				is_kyc: token.is_kyc,
				is_mintable: token.is_mintable,
				is_taxable: token.is_taxable,
				is_partner: token.is_partner,
				is_platform: true,
				lp_burned: token.lp_burned,
				tax_ceiling_locked: token.tax_ceiling_locked,
				owner_renounced: token.owner_renounced,
			} : null,
		};
	});

	return { launches };
};
