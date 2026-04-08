/**
 * Wallet Vault API
 *
 * POST /api/wallet        — save encrypted vault (create or update)
 * GET  /api/wallet        — get encrypted vault + salt (for decryption on client)
 * DELETE /api/wallet      — delete vault (danger)
 *
 * All endpoints require Supabase Auth (Google login) — JWT in Authorization header.
 * Salt is derived server-side: HMAC(WALLET_SECRET, user_id).
 * Encrypted blobs are opaque to the server — decryption happens client-side with PIN.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { env } from '$env/dynamic/private';

/** Derive a deterministic salt from server secret + user ID */
async function deriveSalt(userId: string): Promise<string> {
	const secret = env.WALLET_SECRET;
	if (!secret) throw new Error('WALLET_SECRET not configured');

	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(userId));
	const bytes = new Uint8Array(signature);
	return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Verify Supabase JWT and return user ID */
async function getAuthUser(request: Request): Promise<string> {
	const authHeader = request.headers.get('authorization');
	if (!authHeader?.startsWith('Bearer ')) {
		throw new Error('Missing auth token');
	}
	const token = authHeader.slice(7);

	const { data, error: authError } = await supabaseAdmin.auth.getUser(token);
	if (authError || !data.user) {
		throw new Error('Invalid or expired token');
	}
	return data.user.id;
}

// ── GET: Fetch vault + salt ──
export const GET: RequestHandler = async ({ request }) => {
	let userId: string;
	try {
		userId = await getAuthUser(request);
	} catch (e: any) {
		return error(401, e.message);
	}

	if (!env.WALLET_SECRET) {
		return error(500, 'WALLET_SECRET not configured');
	}

	const salt = await deriveSalt(userId);

	const { data: vault } = await supabaseAdmin
		.from('wallet_vaults')
		.select('primary_blob, recovery_blob_1, recovery_blob_2, recovery_blob_3, account_count, created_at')
		.eq('user_id', userId)
		.single();

	return json({
		salt,
		vault: vault || null,
	});
};

// ── POST: Create or update vault ──
export const POST: RequestHandler = async ({ request }) => {
	let userId: string;
	try {
		userId = await getAuthUser(request);
	} catch (e: any) {
		return error(401, e.message);
	}

	const body = await request.json();
	const { primaryBlob, recoveryBlob1, recoveryBlob2, recoveryBlob3, accountCount, defaultAddress } = body;

	if (!primaryBlob || !recoveryBlob1 || !recoveryBlob2 || !recoveryBlob3) {
		return error(400, 'Missing encrypted blobs');
	}

	const { error: dbErr } = await supabaseAdmin
		.from('wallet_vaults')
		.upsert({
			user_id: userId,
			primary_blob: primaryBlob,
			recovery_blob_1: recoveryBlob1,
			recovery_blob_2: recoveryBlob2,
			recovery_blob_3: recoveryBlob3,
			account_count: accountCount || 1,
			default_address: defaultAddress || null,
			updated_at: new Date().toISOString(),
		}, { onConflict: 'user_id' });

	if (dbErr) return error(500, dbErr.message);

	const salt = await deriveSalt(userId);
	return json({ ok: true, salt });
};

// ── DELETE: Remove vault (danger — user loses access if no backup) ──
export const DELETE: RequestHandler = async ({ request }) => {
	let userId: string;
	try {
		userId = await getAuthUser(request);
	} catch (e: any) {
		return error(401, e.message);
	}

	const { error: dbErr } = await supabaseAdmin
		.from('wallet_vaults')
		.delete()
		.eq('user_id', userId);

	if (dbErr) return error(500, dbErr.message);

	return json({ ok: true });
};
