import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ethers } from 'ethers';

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

const NETWORKS = [
	{
		chain_id: 31337,
		name: 'Localhost',
		factory: '0x0B306BF915C4d645ff596e518fAf3F9669b97016', // Updated by deploy script
		rpc: 'http://127.0.0.1:8545'
	}
];

export const GET: RequestHandler = async ({ url }) => {
	const limit = Number(url.searchParams.get('limit') ?? 12);

	// Return cache if fresh
	if (Date.now() - cache.timestamp < CACHE_TTL && cache.data.length > 0) {
		return json(cache.data.slice(0, limit));
	}

	const partners: any[] = [];

	for (const net of NETWORKS) {
		try {
			const provider = new ethers.JsonRpcProvider(net.rpc);
			const factory = new ethers.Contract(net.factory, FACTORY_ABI, provider);

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
