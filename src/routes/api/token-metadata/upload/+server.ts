import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];
const BUCKET = 'token-logos';

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

	// Verify caller is creator or admin
	if (!isAdmin) {
		const { data: token } = await supabaseAdmin
			.from('created_tokens')
			.select('creator')
			.eq('address', address)
			.eq('chain_id', chainId)
			.single();

		// Allow upload even if token not in DB yet (pre-daemon)
		if (token && token.creator.toLowerCase() !== wallet) {
			return error(403, 'Only the token creator can upload');
		}
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
