import type { LayoutServerLoad } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

const CHAIN_MAP: Record<string, number> = {
	bsc: 56, eth: 1, base: 8453, arbitrum: 42161, polygon: 137,
};

export const load: LayoutServerLoad = async ({ params }) => {
	const chainSlug = params.chain?.toLowerCase() || 'bsc';
	const chainId = CHAIN_MAP[chainSlug] || 56;

	// Fetch the network config from platform_config so child pages have it SSR-side
	let network = null;
	try {
		const { data } = await supabaseAdmin
			.from('platform_config')
			.select('value')
			.eq('key', 'networks')
			.single();
		if (data?.value && Array.isArray(data.value)) {
			network = data.value.find((n: any) => n.chain_id === chainId) || null;
		}
	} catch {}

	return { chainSlug, chainId, network };
};
