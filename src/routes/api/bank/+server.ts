import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { getBanks } from '$lib/flutterwave';

// GET /api/bank — list Nigerian banks (cached, with logos from nigerianbanks.xyz)
export const GET: RequestHandler = async ({ url }) => {
	const refresh = url.searchParams.get('refresh') === 'true';

	// Try DB cache first
	if (!refresh) {
		const { data } = await supabaseAdmin
			.from('ng_banks')
			.select('code, name, slug, logo, ussd')
			.eq('active', true)
			.order('name');

		if (data && data.length > 0) {
			return json(data);
		}
	}

	// Fetch from both Flutterwave (codes) and nigerianbanks.xyz (logos)
	try {
		const [flwBanks, ngnBanksRes] = await Promise.all([
			getBanks().catch(() => []),
			fetch('https://nigerianbanks.xyz').then(r => r.json()).catch(() => [])
		]);

		// Build logo map from nigerianbanks.xyz (keyed by code)
		const logoMap = new Map<string, { logo: string; ussd: string; slug: string }>();
		if (Array.isArray(ngnBanksRes)) {
			for (const b of ngnBanksRes) {
				if (b.code) {
					logoMap.set(b.code, {
						logo: b.logo || '',
						ussd: b.ussd || '',
						slug: b.slug || ''
					});
				}
			}
		}

		// Merge: Flutterwave has more banks (597), nigerianbanks.xyz has logos (47)
		const banks = flwBanks.map(b => {
			const extra = logoMap.get(b.code);
			return {
				code: b.code,
				name: b.name,
				slug: extra?.slug || b.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
				logo: extra?.logo || '',
				ussd: extra?.ussd || '',
				active: true
			};
		});

		// Also add any banks from nigerianbanks.xyz not in Flutterwave
		for (const [code, extra] of logoMap) {
			if (!banks.find(b => b.code === code)) {
				const ngnBank = (ngnBanksRes as any[]).find((b: any) => b.code === code);
				if (ngnBank) {
					banks.push({
						code,
						name: ngnBank.name,
						slug: extra.slug,
						logo: extra.logo,
						ussd: extra.ussd,
						active: true
					});
				}
			}
		}

		if (banks.length > 0) {
			await supabaseAdmin
				.from('ng_banks')
				.upsert(banks, { onConflict: 'code' });

			return json(banks.map(b => ({
				code: b.code, name: b.name, slug: b.slug, logo: b.logo, ussd: b.ussd
			})));
		}
	} catch {}

	// Fallback to DB
	const { data } = await supabaseAdmin
		.from('ng_banks')
		.select('code, name, slug, logo, ussd')
		.eq('active', true)
		.order('name');

	return json(data || []);
};
