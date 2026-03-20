import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ethers } from 'ethers';
import { env } from '$env/dynamic/private';
import { supabaseAdmin } from '$lib/supabaseServer';
import { LAUNCHPAD_FACTORY_ABI, LAUNCH_INSTANCE_ABI, fetchLaunchInfo, fetchTokenMeta } from '$lib/launchpad';

// Networks with active launchpads (server-side config)
const LAUNCHPAD_NETWORKS = [
	{
		chain_id: 56,
		name: 'BSC',
		launchpad_address: '0x9a7c5e6a4343E881152d3D4A8709289B4f46E071',
		rpc: 'https://bsc-dataseed.binance.org',
		usdt_decimals: 18
	}
];

// POST /api/launches/sync — sync on-chain launches into database
// Protected by SYNC_SECRET to prevent abuse (expensive RPC calls)
export const POST: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('authorization');
	if (env.SYNC_SECRET && authHeader !== `Bearer ${env.SYNC_SECRET}`) {
		return error(401, 'Unauthorized');
	}

	const results = { synced: 0, errors: 0 };

	for (const net of LAUNCHPAD_NETWORKS) {
		const provider = new ethers.JsonRpcProvider(net.rpc);

		try {
			const factory = new ethers.Contract(
				net.launchpad_address,
				LAUNCHPAD_FACTORY_ABI,
				provider
			);

			const total = Number(await factory.totalLaunches());

			// Get existing launches in DB for this chain
			const { data: existing } = await supabaseAdmin
				.from('launches')
				.select('address')
				.eq('chain_id', net.chain_id);

			const existingAddresses = new Set(
				(existing || []).map((l: { address: string }) => l.address)
			);

			// Sync all launches (update existing, insert new)
			for (let i = 0; i < total; i++) {
				try {
					const launchAddress = await factory.launches(i);
					const addr = launchAddress.toLowerCase();

					const info = await fetchLaunchInfo(launchAddress, provider);
					const meta = await fetchTokenMeta(info.token, provider);

					const row = {
						address: addr,
						chain_id: net.chain_id,
						token_address: info.token.toLowerCase(),
						creator: info.creator.toLowerCase(),
						curve_type: info.curveType,
						state: info.state,
						soft_cap: info.softCap.toString(),
						hard_cap: info.hardCap.toString(),
						total_base_raised: info.totalBaseRaised.toString(),
						tokens_sold: info.tokensSold.toString(),
						tokens_for_curve: info.tokensForCurve.toString(),
						tokens_for_lp: info.tokensForLP.toString(),
						creator_allocation_bps: Number(info.creatorAllocationBps),
						current_price: info.currentPrice.toString(),
						deadline: Number(info.deadline),
						start_timestamp: Number(info.startTimestamp),
						total_tokens_required: info.totalTokensRequired.toString(),
						total_tokens_deposited: info.totalTokensDeposited.toString(),
						token_name: meta.name,
						token_symbol: meta.symbol,
						token_decimals: meta.decimals,
						usdt_decimals: net.usdt_decimals
					};

					await supabaseAdmin
						.from('launches')
						.upsert(row, { onConflict: 'address,chain_id' });

					results.synced++;
				} catch (e) {
					results.errors++;
				}
			}
		} catch (e) {
			results.errors++;
		}
	}

	return json(results);
};
