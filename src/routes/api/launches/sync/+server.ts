import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ethers } from 'ethers';
import { env } from '$env/dynamic/private';
import { supabaseAdmin } from '$lib/supabaseServer';
import { LAUNCHPAD_FACTORY_ABI, LAUNCH_INSTANCE_ABI, fetchLaunchInfo, fetchTokenMeta } from '$lib/launchpad';

// Networks with active launchpads (server-side config)
const LAUNCHPAD_NETWORKS = [
	{
		chain_id: 31337,
		name: 'Localhost',
		launchpad_address: '0x959922bE3CAee4b8Cd9a407cc3ac1C251C2007B1',
		platform_address: '0x0B306BF915C4d645ff596e518fAf3F9669b97016',
		rpc: 'http://127.0.0.1:8545',
		usdt_decimals: 6
	}
];

const TOKEN_INFO_ABI = ['function tokenInfo(address) view returns (address creator, bool isMintable, bool isTaxable, bool isPartnership)'];
const OWNER_ABI = ['function owner() view returns (address)'];

// POST /api/launches/sync — sync on-chain launches into database
// Protected by SYNC_SECRET to prevent abuse (expensive RPC calls)
export const POST: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('authorization');
	if (!env.SYNC_SECRET || authHeader !== `Bearer ${env.SYNC_SECRET}`) {
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

					// Check token properties
					let isPartner = false;
					let isMintable = false;
					let isTaxable = false;
					let isRenounced = false;

					if (net.platform_address) {
						try {
							const factory = new ethers.Contract(net.platform_address, TOKEN_INFO_ABI, provider);
							const tInfo = await factory.tokenInfo(info.token);
							isMintable = tInfo[1];
							isTaxable = tInfo[2];
							isPartner = tInfo[3];
						} catch {}
					}

					// Check ownership — renounced if owner is zero address
					try {
						const tokenContract = new ethers.Contract(info.token, OWNER_ABI, provider);
						const owner = await tokenContract.owner();
						isRenounced = owner === ethers.ZeroAddress;
					} catch {
						// Token may not have owner() — skip
					}

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
						usdt_decimals: net.usdt_decimals,
						is_partner: isPartner
					};

					await supabaseAdmin
						.from('launches')
						.upsert(row, { onConflict: 'address,chain_id' });

					// Auto-detect and upsert badges
					const badgesToSet: { badge_type: string; granted_by: string }[] = [];
					if (isMintable) badgesToSet.push({ badge_type: 'mintable', granted_by: 'system' });
					if (isTaxable) badgesToSet.push({ badge_type: 'taxable', granted_by: 'system' });
					if (isPartner) badgesToSet.push({ badge_type: 'partner', granted_by: 'system' });
					if (isRenounced) badgesToSet.push({ badge_type: 'renounced', granted_by: 'system' });

					for (const b of badgesToSet) {
						await supabaseAdmin.from('badges').upsert({
							launch_address: addr,
							chain_id: net.chain_id,
							badge_type: b.badge_type,
							granted_by: b.granted_by
						}, { onConflict: 'launch_address,chain_id,badge_type' });
					}

					// Remove renounced badge if owner is no longer zero
					if (!isRenounced) {
						await supabaseAdmin.from('badges')
							.delete()
							.eq('launch_address', addr)
							.eq('chain_id', net.chain_id)
							.eq('badge_type', 'renounced')
							.eq('granted_by', 'system');
					}

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
