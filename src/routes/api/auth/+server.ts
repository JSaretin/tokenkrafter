import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// POST /api/auth — authenticate via wallet signature
// The hook handles session creation from the signature in the body.
// This endpoint just confirms the session was created.
export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.wallet) {
		return json({ ok: false }, { status: 401 });
	}
	return json({ ok: true, wallet: locals.wallet, isAdmin: locals.isAdmin });
};

// GET /api/auth — check current session
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.wallet) {
		return json({ ok: false });
	}
	return json({ ok: true, wallet: locals.wallet, isAdmin: locals.isAdmin });
};
