import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { ethers } from 'ethers';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];
const BUCKET = 'launch-logos';

// POST /api/launches/upload — upload logo image for a launch
// Requires wallet signature; recovered address must match DB creator
export const POST: RequestHandler = async ({ request }) => {
	const formData = await request.formData();
	const file = formData.get('file') as File | null;
	const address = formData.get('address') as string | null;
	const chainId = formData.get('chain_id') as string | null;
	const signature = formData.get('signature') as string | null;
	const signedMessage = formData.get('signed_message') as string | null;

	if (!file || !address || !chainId) {
		return error(400, 'Missing file, address, or chain_id');
	}
	if (!signature || !signedMessage) {
		return error(400, 'Signature required');
	}

	if (!ALLOWED_TYPES.includes(file.type)) {
		return error(400, 'Invalid file type. Allowed: PNG, JPEG, WebP, GIF, SVG');
	}

	if (file.size > MAX_FILE_SIZE) {
		return error(400, `File too large. Max size is ${MAX_FILE_SIZE / (1024 * 1024)} MB`);
	}

	// Recover wallet from signature
	let walletAddress: string;
	try {
		walletAddress = ethers.verifyMessage(signedMessage, signature).toLowerCase();
		const tsMatch = signedMessage.match(/Timestamp: (\d+)/);
		if (tsMatch && Date.now() - parseInt(tsMatch[1]) > 5 * 60 * 1000) {
			return error(400, 'Signature expired');
		}
	} catch {
		return error(400, 'Invalid signature');
	}

	// Verify the recovered address is the creator
	const { data: launch } = await supabaseAdmin
		.from('launches')
		.select('creator')
		.eq('address', address.toLowerCase())
		.eq('chain_id', Number(chainId))
		.single();

	if (!launch) {
		return error(404, 'Launch not found');
	}

	if (launch.creator !== walletAddress) {
		return error(403, 'Only the launch creator can upload images');
	}

	// Upload to Supabase Storage
	const ext = file.name.split('.').pop() || 'png';
	const filePath = `${chainId}/${address.toLowerCase()}/logo.${ext}`;
	const arrayBuffer = await file.arrayBuffer();

	const { error: uploadError } = await supabaseAdmin.storage
		.from(BUCKET)
		.upload(filePath, arrayBuffer, {
			contentType: file.type,
			upsert: true
		});

	if (uploadError) {
		return error(500, `Upload failed: ${uploadError.message}`);
	}

	const { data: urlData } = supabaseAdmin.storage
		.from(BUCKET)
		.getPublicUrl(filePath);

	const logoUrl = urlData.publicUrl;

	// Update launch record with logo URL
	await supabaseAdmin
		.from('launches')
		.update({ logo_url: logoUrl })
		.eq('address', address.toLowerCase())
		.eq('chain_id', Number(chainId));

	return json({ logo_url: logoUrl });
};
