import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ethers } from 'ethers';
import { supabaseAdmin } from '$lib/supabaseServer';

const FACTORY_ABI = [
	'function totalTokensCreated() view returns (uint256)',
	'function tokenInfo(address) view returns (address creator, bool isMintable, bool isTaxable, bool isPartnership)',
	'event TokenCreated(address indexed creator, address indexed tokenAddress, uint8 tokenType, string name, string symbol, uint256 totalSupply, uint8 decimals)'
];

const TOKEN_ABI = [
	'function name() view returns (string)',
	'function symbol() view returns (string)',
	'function totalSupply() view returns (uint256)',
	'function decimals() view returns (uint8)'
];

// In-memory cache (refreshes every 5 minutes)
let cache: { data: any[]; timestamp: number } = { data: [], timestamp: 0 };
const CACHE_TTL = 5 * 60 * 1000;

/** Read networks from platform_config DB table */
async function getNetworks(): Promise<Array<{ chain_id: number; name: string; rpc: string; platform_address: string }>> {
	const { data } = await supabaseAdmin
		.from('platform_config')
		.select('value')
		.eq('key', 'networks')
		.single();

	if (!data?.value) return [];
	return (data.value as any[]).filter((n: any) => n.rpc && n.platform_address);
}

export const GET: RequestHandler = async ({ url }) => {
	const limit = Number(url.searchParams.get('limit') ?? 12);

	// Return cache if fresh
	if (Date.now() - cache.timestamp < CACHE_TTL && cache.data.length > 0) {
		return json(cache.data.slice(0, limit));
	}

	const networks = await getNetworks();
	const partners: any[] = [];

	for (const net of networks) {
		try {
			const provider = new ethers.JsonRpcProvider(net.rpc, net.chain_id, { staticNetwork: true });
			const factory = new ethers.Contract(net.platform_address, FACTORY_ABI, provider);

			// Query TokenCreated events for partner types (typeKey 4-7)
			const filter = factory.filters.TokenCreated();
			const events = await factory.queryFilter(filter, 0, 'latest');

			for (const event of events) {
				try {
					const parsed = factory.interface.parseLog({
						topics: [...event.topics],
						data: event.data
					});
					if (!parsed) continue;

					const typeKey = Number(parsed.args.tokenType);
					if (typeKey < 4) continue; // Not a partner token

					const tokenAddr = parsed.args.tokenAddress;
					const token = new ethers.Contract(tokenAddr, TOKEN_ABI, provider);

					const [name, symbol, totalSupply, decimals] = await Promise.all([
						token.name().catch(() => parsed.args.name),
						token.symbol().catch(() => parsed.args.symbol),
						token.totalSupply().catch(() => 0n),
						token.decimals().catch(() => 18)
					]);

					partners.push({
						address: tokenAddr,
						chain_id: net.chain_id,
						network: net.name,
						name,
						symbol,
						totalSupply: totalSupply.toString(),
						decimals: Number(decimals),
						creator: parsed.args.creator,
						tokenType: typeKey,
						isMintable: typeKey & 1,
						isTaxable: typeKey & 2
					});
				} catch {
					// skip individual token errors
				}
			}
		} catch (e) {
			console.warn(`Partner fetch failed for ${net.name}:`, e);
		}
	}

	cache = { data: partners, timestamp: Date.now() };
	return json(partners.slice(0, limit));
};
