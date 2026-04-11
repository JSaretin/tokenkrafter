/**
 * Wallets API — multi-wallet embedded wallet storage.
 *
 *   GET    /api/wallets       — list all wallets for current user (+ salt)
 *   POST   /api/wallets       — create a new wallet row (encrypted blob from client)
 *
 * Per-wallet operations (rename, delete, primary, preferences) live at
 * /api/wallets/[id].
 *
 * All endpoints require Supabase Auth (Google login) — JWT in Authorization header.
 * Encrypted blobs are opaque to the server — decryption happens client-side
 * with the user's PIN.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';
import { env } from '$env/dynamic/private';

/** Derive a deterministic salt from the server secret + user id.
 *  Salt is user-scoped (shared across all that user's wallets). */
async function deriveSalt(userId: string): Promise<string> {
	const secret = env.WALLET_SECRET;
	if (!secret) throw new Error('WALLET_SECRET not configured');

	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(userId));
	const bytes = new Uint8Array(signature);
	return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function getAuthUser(request: Request): Promise<string> {
	const authHeader = request.headers.get('authorization');
	if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing auth token');
	const token = authHeader.slice(7);
	const { data, error: authError } = await supabaseAdmin.auth.getUser(token);
	if (authError || !data.user) throw new Error('Invalid or expired token');
	return data.user.id;
}

// ── GET: list all wallets for the current user ─────────────────────────
export const GET: RequestHandler = async ({ request }) => {
	let userId: string;
	try {
		userId = await getAuthUser(request);
	} catch (e: any) {
		return error(401, e.message);
	}

	if (!env.WALLET_SECRET) return error(500, 'WALLET_SECRET not configured');
	const salt = await deriveSalt(userId);

	const { data: wallets, error: dbErr } = await supabaseAdmin
		.from('wallets')
		.select(
			'id, name, primary_blob, recovery_blob_1, recovery_blob_2, recovery_blob_3, account_count, default_address, is_imported, is_primary, preferences, created_at',
		)
		.eq('user_id', userId)
		.order('is_primary', { ascending: false })
		.order('created_at', { ascending: true });

	if (dbErr) return error(500, dbErr.message);

	return json({
		salt,
		wallets: wallets || [],
	});
};

// ── POST: create a new wallet ──────────────────────────────────────────
// Accepts an already-encrypted primary_blob + optional recovery blobs from
// the client. The client does the crypto; we just store the ciphertext.
//
// Body:
//   {
//     name: string,                       // user label
//     primaryBlob: string,                // AES(seed, PBKDF2(pin, salt))
//     recoveryBlob1?: string | null,      // null for imported wallets
//     recoveryBlob2?: string | null,
//     recoveryBlob3?: string | null,
//     accountCount?: number,              // defaults to 1
//     defaultAddress?: string,            // first derived address (display)
//     isImported?: boolean,               // user imported their own mnemonic
//     setPrimary?: boolean,               // make this the user's new primary
//   }
export const POST: RequestHandler = async ({ request }) => {
	let userId: string;
	try {
		userId = await getAuthUser(request);
	} catch (e: any) {
		return error(401, e.message);
	}

	const body = await request.json();
	const {
		name,
		primaryBlob,
		recoveryBlob1 = null,
		recoveryBlob2 = null,
		recoveryBlob3 = null,
		accountCount = 1,
		defaultAddress = null,
		isImported = false,
		setPrimary = false,
	} = body;

	if (!name || typeof name !== 'string') return error(400, 'Name required');
	if (!primaryBlob || typeof primaryBlob !== 'string') return error(400, 'Missing primary blob');

	// Decide primary flag: if the user has no wallets yet, the first one is
	// primary by default. Otherwise respect `setPrimary` from the body.
	let isPrimary = Boolean(setPrimary);
	if (!isPrimary) {
		const { count } = await supabaseAdmin
			.from('wallets')
			.select('id', { count: 'exact', head: true })
			.eq('user_id', userId);
		if ((count ?? 0) === 0) isPrimary = true;
	} else {
		// If explicitly setting primary, clear the flag on any existing primary.
		await supabaseAdmin
			.from('wallets')
			.update({ is_primary: false })
			.eq('user_id', userId)
			.eq('is_primary', true);
	}

	const { data, error: dbErr } = await supabaseAdmin
		.from('wallets')
		.insert({
			user_id: userId,
			name: name.trim().slice(0, 40),
			primary_blob: primaryBlob,
			recovery_blob_1: recoveryBlob1,
			recovery_blob_2: recoveryBlob2,
			recovery_blob_3: recoveryBlob3,
			account_count: Math.max(1, Math.min(50, Number(accountCount) || 1)),
			default_address: defaultAddress,
			is_imported: Boolean(isImported),
			is_primary: isPrimary,
		})
		.select()
		.single();

	if (dbErr) return error(500, dbErr.message);

	return json({ wallet: data }, { status: 201 });
};
