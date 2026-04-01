import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyAdmin, createAdminSession, verifyAdminSession } from '$lib/auth';

const SESSION_MAX_AGE = 60 * 60 * 24; // 24 hours

// GET /api/admin/verify — check existing session cookie
export const GET: RequestHandler = async ({ cookies }) => {
	const token = cookies.get('admin_session');
	if (!token) return json({ ok: false });

	const wallet = await verifyAdminSession(token);
	if (!wallet) return json({ ok: false });

	return json({ ok: true, wallet });
};

// POST /api/admin/verify — verify wallet signature, set session cookie
export const POST: RequestHandler = async ({ request, cookies }) => {
	const body = await request.json();

	if (!body.signature || !body.signed_message) {
		return error(400, 'Signature required');
	}

	try {
		const wallet = verifyAdmin(body.signature, body.signed_message);

		// Create session token and set cookie
		const token = await createAdminSession(wallet);
		cookies.set('admin_session', token, {
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'strict',
			maxAge: SESSION_MAX_AGE
		});

		return json({ ok: true, wallet });
	} catch (e: any) {
		return error(403, e.message || 'Not authorized');
	}
};

// DELETE /api/admin/verify — clear session
export const DELETE: RequestHandler = async ({ cookies }) => {
	cookies.delete('admin_session', { path: '/' });
	return json({ ok: true });
};
