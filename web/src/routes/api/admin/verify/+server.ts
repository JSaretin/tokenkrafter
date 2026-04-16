import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyAdmin, createSession, verifySession } from '$lib/auth';

const SESSION_MAX_AGE = 60 * 60 * 24; // 24 hours

// GET /api/admin/verify — check existing session cookie
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.isAdmin) return json({ ok: false });
	return json({ ok: true, wallet: locals.wallet });
};

// POST /api/admin/verify — verify wallet signature, set admin session cookie
// The hook already sets a session from the signature, but we need to verify it's an admin
export const POST: RequestHandler = async ({ locals, cookies }) => {
	if (!locals.wallet) return error(400, 'Signature required');

	// The hook recovered the wallet — now check if it's an admin
	if (!locals.isAdmin) {
		// Clear the non-admin session the hook might have set
		cookies.delete('session', { path: '/' });
		return error(403, 'Not an admin');
	}

	return json({ ok: true, wallet: locals.wallet });
};

// DELETE /api/admin/verify — clear session
export const DELETE: RequestHandler = async ({ cookies }) => {
	cookies.delete('session', { path: '/' });
	return json({ ok: true });
};
