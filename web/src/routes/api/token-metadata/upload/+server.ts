import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { ethers } from 'ethers';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];
const BUCKET = 'token-logos';

const OWNER_ABI = ['function owner() view returns (address)'];

/** Mirror of /api/token-metadata's isOnChainOwner: the indexer stores
 *  creator = msg.sender from the TokenCreated event, which for tokens
 *  deployed via PlatformRouter is the router address — not the user
 *  wallet that signed the tx. The DB creator column is therefore not
 *  trustworthy for auth; we fall back to a live Ownable.owner() check
 *  before rejecting. */
async function isOnChainOwner(address: string, chainId: number, wallet: string): Promise<boolean> {
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
		const c = new ethers.Contract(address, OWNER_ABI, provider);
		const owner = String(await c.owner()).toLowerCase();
		return owner === wallet.toLowerCase();
	} catch {
		return false;
	}
}

// POST /api/token-metadata/upload — upload token logo
// Auth: wallet session (from cookie)
export const POST: RequestHandler = async ({ request, locals }) => {
	const wallet = (locals as any).wallet?.toLowerCase();
	const isAdmin = (locals as any).isAdmin;
	if (!wallet) return error(401, 'Wallet session required');

	const formData = await request.formData();
	const file = formData.get('file') as File | null;
	const address = (formData.get('address') as string || '').toLowerCase();
	const chainId = parseInt(formData.get('chain_id') as string || '56');

	if (!file || !address) return error(400, 'Missing file or address');
	if (!ALLOWED_TYPES.includes(file.type)) return error(400, 'Invalid file type. Allowed: PNG, JPEG, WebP, GIF, SVG');
	if (file.size > MAX_FILE_SIZE) return error(400, 'File too large. Max 2 MB');

	// Verify caller is creator or admin. DB `creator` is stamped by the
	// indexer to msg.sender of the TokenCreated event — for tokens
	// deployed via PlatformRouter that's the router address, NOT the
	// user wallet. Fall back to a live Ownable.owner() check (same
	// pattern as /api/token-metadata PUT) before rejecting, so the
	// actual on-chain owner can always upload.
	if (!isAdmin) {
		const { data: token } = await supabaseAdmin
			.from('created_tokens')
			.select('creator')
			.eq('address', address)
			.eq('chain_id', chainId)
			.single();

		if (token && token.creator.toLowerCase() !== wallet) {
			const isOwner = await isOnChainOwner(address, chainId, wallet);
			if (!isOwner) return error(403, 'Only the token creator can upload');
		}
		// Token not in DB yet (pre-daemon) — allow upload; the row gets
		// created with the bot's wallet as creator on next indexer pass.
	}

	// Upload to Supabase Storage — always save as .png for consistency
	const filePath = `${chainId}/${address}/logo.png`;
	const arrayBuffer = await file.arrayBuffer();

	const { error: uploadError } = await supabaseAdmin.storage
		.from(BUCKET)
		.upload(filePath, arrayBuffer, { contentType: file.type, upsert: true });

	if (uploadError) return error(500, `Upload failed: ${uploadError.message}`);

	const { data: urlData } = supabaseAdmin.storage
		.from(BUCKET)
		.getPublicUrl(filePath);

	const logoUrl = urlData.publicUrl;

	// Update token record
	const { data: existing } = await supabaseAdmin
		.from('created_tokens')
		.select('address')
		.eq('address', address)
		.eq('chain_id', chainId)
		.single();

	if (existing) {
		await supabaseAdmin
			.from('created_tokens')
			.update({ logo_url: logoUrl })
			.eq('address', address)
			.eq('chain_id', chainId);
	}

	return json({ logo_url: logoUrl });
};
