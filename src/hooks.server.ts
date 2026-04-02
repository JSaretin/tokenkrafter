import type { Handle } from '@sveltejs/kit';
import { verifySession, recoverWallet, createSession, isAdminWallet } from '$lib/auth';

const USER_SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds
const ADMIN_SESSION_MAX_AGE = 24 * 60 * 60; // 24 hours in seconds

export const handle: Handle = async ({ event, resolve }) => {
	const { cookies, request } = event;
	const method = request.method;

	// Connected wallet sent by frontend (may be null if not connected)
	const connectedWallet = request.headers.get('x-wallet-address')?.toLowerCase() || null;

	// 1. Check existing session cookie
	const sessionToken = cookies.get('session');
	if (sessionToken) {
		const session = await verifySession(sessionToken);
		if (session) {
			// If user switched wallets, invalidate session
			// (skip check if no wallet header — user might not be connected yet)
			if (connectedWallet && connectedWallet !== session.wallet) {
				cookies.delete('session', { path: '/' });
				// Don't set locals — force re-authentication
			} else {
				event.locals.wallet = session.wallet;
				event.locals.isAdmin = session.role === 'admin';
			}
		} else {
			// Expired or invalid — clear it
			cookies.delete('session', { path: '/' });
		}
	}

	// 2. For write requests without a session, check for signature in body
	//    If valid, create a session cookie so future requests don't need signing
	if (!event.locals.wallet && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
		const contentType = request.headers.get('content-type') || '';

		// Only try to parse JSON bodies (skip file uploads etc.)
		if (contentType.includes('application/json')) {
			try {
				// Clone the request so the endpoint can still read it
				const cloned = request.clone();
				const body = await cloned.json();

				if (body.signature && body.signed_message) {
					const wallet = recoverWallet(body.signature, body.signed_message);
					const isAdmin = isAdminWallet(wallet);
					const role = isAdmin ? 'admin' as const : 'user' as const;

					event.locals.wallet = wallet;
					event.locals.isAdmin = isAdmin;

					// Set session cookie
					const token = await createSession(wallet, role);
					cookies.set('session', token, {
						path: '/',
						httpOnly: true,
						secure: true,
						sameSite: 'strict',
						maxAge: isAdmin ? ADMIN_SESSION_MAX_AGE : USER_SESSION_MAX_AGE
					});
				}
			} catch {
				// Signature invalid or body not JSON — let endpoint handle it
			}
		}
	}

	return resolve(event);
};
