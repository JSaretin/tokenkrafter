/**
 * Single-wallet operations.
 *
 *   GET    /api/wallets/[id]        — fetch one wallet (rarely needed, list usually covers it)
 *   PATCH  /api/wallets/[id]        — update name, account count, default address, preferences
 *   DELETE /api/wallets/[id]        — delete a wallet (guards: not the last one, not the primary unless another promoted first)
 *   POST   /api/wallets/[id]/primary — flip is_primary (handled via PATCH setPrimary: true below)
 *
 * Auth via Supabase JWT in Authorization header. Ownership verified on every call.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/supabaseServer';

async function getAuthUser(request: Request): Promise<string> {
	const authHeader = request.headers.get('authorization');
	if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing auth token');
	const token = authHeader.slice(7);
	const { data, error: authError } = await supabaseAdmin.auth.getUser(token);
	if (authError || !data.user) throw new Error('Invalid or expired token');
	return data.user.id;
}

/** Verify the caller owns the wallet identified by walletId. Returns the row. */
async function loadOwnedWallet(userId: string, walletId: string) {
	const { data, error: dbErr } = await supabaseAdmin
		.from('wallets')
		.select('*')
		.eq('id', walletId)
		.eq('user_id', userId)
		.single();
	if (dbErr || !data) return null;
	return data;
}

// ── GET ────────────────────────────────────────────────────────────────
export const GET: RequestHandler = async ({ request, params }) => {
	let userId: string;
	try {
		userId = await getAuthUser(request);
	} catch (e: any) {
		return error(401, e.message);
	}

	const wallet = await loadOwnedWallet(userId, params.id!);
	if (!wallet) return error(404, 'Wallet not found');
	return json({ wallet });
};

// ── PATCH: update wallet metadata ──────────────────────────────────────
// Accepted fields:
//   name?: string
//   accountCount?: number
//   defaultAddress?: string
//   preferences?: object          (merged with existing)
//   setPrimary?: boolean          (flips is_primary across the user's wallets)
//   primaryBlob?: string          (re-encrypted seed — only the wallet owner can do this)
//   recoveryBlob1?, recoveryBlob2?, recoveryBlob3?: string
export const PATCH: RequestHandler = async ({ request, params }) => {
	let userId: string;
	try {
		userId = await getAuthUser(request);
	} catch (e: any) {
		return error(401, e.message);
	}

	const wallet = await loadOwnedWallet(userId, params.id!);
	if (!wallet) return error(404, 'Wallet not found');

	const body = await request.json();
	const updates: Record<string, any> = {};

	if (typeof body.name === 'string' && body.name.trim()) {
		updates.name = body.name.trim().slice(0, 40);
	}
	if (Number.isFinite(body.accountCount)) {
		updates.account_count = Math.max(1, Math.min(50, Number(body.accountCount)));
	}
	if (typeof body.defaultAddress === 'string') {
		updates.default_address = body.defaultAddress;
	}
	if (body.preferences && typeof body.preferences === 'object') {
		updates.preferences = { ...(wallet.preferences || {}), ...body.preferences };
	}
	if (typeof body.primaryBlob === 'string') {
		updates.primary_blob = body.primaryBlob;
	}
	if (typeof body.recoveryBlob1 === 'string' || body.recoveryBlob1 === null) {
		updates.recovery_blob_1 = body.recoveryBlob1;
	}
	if (typeof body.recoveryBlob2 === 'string' || body.recoveryBlob2 === null) {
		updates.recovery_blob_2 = body.recoveryBlob2;
	}
	if (typeof body.recoveryBlob3 === 'string' || body.recoveryBlob3 === null) {
		updates.recovery_blob_3 = body.recoveryBlob3;
	}

	// setPrimary is a cross-row operation — use RPC for atomicity.
	const settingPrimary = body.setPrimary === true;
	if (settingPrimary) {
		const { error: rpcErr } = await supabaseAdmin.rpc('set_primary_wallet', {
			_user_id: userId,
			_wallet_id: params.id!
		});
		if (rpcErr) {
			console.error('[wallets PATCH set_primary_wallet] RPC error:', rpcErr.message);
			return error(500, `Failed to set primary: ${rpcErr.message}`);
		}
		// RPC already set is_primary on this wallet, no need to include in updates
	}

	// If the only change was setPrimary, the RPC has already done the work —
	// just fetch and return the updated row instead of 400'ing on "no fields".
	// Without this, set-primary-only PATCHes failed with "No fields to update"
	// even after the RPC succeeded, leaving the FE thinking the operation
	// errored when it actually landed.
	if (Object.keys(updates).length === 0) {
		if (!settingPrimary) return error(400, 'No fields to update');
		const { data: row } = await supabaseAdmin
			.from('wallets')
			.select('*')
			.eq('id', params.id!)
			.eq('user_id', userId)
			.single();
		return json({ wallet: row });
	}

	const { data, error: dbErr } = await supabaseAdmin
		.from('wallets')
		.update(updates)
		.eq('id', params.id!)
		.eq('user_id', userId)
		.select()
		.single();

	if (dbErr) {
		console.error('[wallets PATCH] DB error:', dbErr.message);
		return error(500, 'Failed to update wallet');
	}
	return json({ wallet: data });
};

// ── DELETE ─────────────────────────────────────────────────────────────
// Guards:
//  - cannot delete the last wallet (leaves user with no signing key)
//  - cannot delete the primary unless another wallet is promoted first
export const DELETE: RequestHandler = async ({ request, params }) => {
	let userId: string;
	try {
		userId = await getAuthUser(request);
	} catch (e: any) {
		return error(401, e.message);
	}

	const wallet = await loadOwnedWallet(userId, params.id!);
	if (!wallet) return error(404, 'Wallet not found');

	const { count } = await supabaseAdmin
		.from('wallets')
		.select('id', { count: 'exact', head: true })
		.eq('user_id', userId);

	if ((count ?? 0) <= 1) {
		return error(400, 'Cannot delete your only wallet');
	}
	if (wallet.is_primary) {
		return error(400, 'Promote another wallet to primary before deleting this one');
	}

	const { error: dbErr } = await supabaseAdmin
		.from('wallets')
		.delete()
		.eq('id', params.id!)
		.eq('user_id', userId);

	if (dbErr) {
		console.error('[wallets DELETE] DB error:', dbErr.message);
		return error(500, 'Failed to delete wallet');
	}
	return json({ ok: true });
};
