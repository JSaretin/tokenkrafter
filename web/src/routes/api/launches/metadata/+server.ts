import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { ethers } from 'ethers';

const LAUNCH_CREATOR_ABI = ['function creator() view returns (address)'];

/** Live on-chain creator check for a launch instance. The DB
 *  `creator` column is set when the launch is indexed and may lag /
 *  mismatch the user's current session wallet — fall back to chain
 *  truth before refusing the metadata update. */
async function isOnChainLaunchCreator(launchAddress: string, chainId: number, wallet: string): Promise<boolean> {
	const { data } = await supabaseAdmin
		.from('platform_config')
		.select('value')
		.eq('key', 'networks')
		.single();
	const nets = (data?.value as any[] | undefined) ?? [];
	const net = nets.find((n: any) => n.chain_id === chainId && n.rpc);
	if (!net?.rpc) return false;
	try {
		const provider = new ethers.JsonRpcProvider(net.rpc, chainId, { staticNetwork: true });
		const c = new ethers.Contract(launchAddress, LAUNCH_CREATOR_ABI, provider);
		const c1 = String(await c.creator()).toLowerCase();
		return c1 === wallet.toLowerCase();
	} catch {
		return false;
	}
}

// PATCH /api/launches/metadata — update off-chain metadata for a launch
// Auth: wallet session (hooks.server.ts), then creator check
export const PATCH: RequestHandler = async ({ request, locals }) => {
	if (!locals.wallet) return error(401, 'Wallet authentication required');

	const body = await request.json();
	const walletAddress = locals.wallet;

	if (!body.address || !body.chain_id) {
		return error(400, 'Missing address or chain_id');
	}

	// Verify the session wallet is the creator
	const { data: launch } = await supabaseAdmin
		.from('launches')
		.select('creator')
		.eq('address', body.address.toLowerCase())
		.eq('chain_id', body.chain_id)
		.single();

	if (!launch) {
		return error(404, 'Launch not found');
	}

	if (launch.creator?.toLowerCase() !== walletAddress.toLowerCase()) {
		// DB creator mismatch — verify against the on-chain `creator()`
		// view before rejecting. Handles indexer lag or string-case drift
		// that locks the real creator out of metadata edits.
		const isOwner = await isOnChainLaunchCreator(body.address, body.chain_id, walletAddress);
		if (!isOwner) return error(403, 'Only the launch creator can update metadata');
	}

	const updates: Record<string, string | null> = {};
	if (body.description !== undefined) updates.description = body.description || null;
	if (body.logo_url !== undefined) updates.logo_url = body.logo_url || null;
	if (body.website !== undefined) updates.website = body.website || null;
	if (body.twitter !== undefined) updates.twitter = body.twitter || null;
	if (body.telegram !== undefined) updates.telegram = body.telegram || null;
	if (body.discord !== undefined) updates.discord = body.discord || null;
	if (body.video_url !== undefined) updates.video_url = body.video_url || null;

	if (Object.keys(updates).length === 0) {
		return error(400, 'No metadata fields provided');
	}

	const { data, error: dbError } = await supabaseAdmin
		.from('launches')
		.update(updates)
		.eq('address', body.address.toLowerCase())
		.eq('chain_id', body.chain_id)
		.select()
		.single();

	if (dbError) {
		return error(500, dbError.message);
	}

	return json(data);
};
