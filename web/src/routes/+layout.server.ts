import type { LayoutServerLoad } from './$types';
import { env } from '$env/dynamic/private';

export const load: LayoutServerLoad = async ({ locals, fetch }) => {
	// Socials come from /api/config/socials, which sets a long
	// Cache-Control header so Cloudflare's edge caches it for a week.
	// SvelteKit's `fetch` here respects HTTP cache, so we get the
	// edge-cached response on warm requests without a Supabase hit.
	let socialLinks: Record<string, string> = {};
	try {
		const res = await fetch('/api/config/socials');
		if (res.ok) {
			const body = await res.json();
			socialLinks = body?.socialLinks ?? {};
		}
	} catch {}

	// Origins from ALLOWED_ORIGINS — used client-side to gate
	// third-party widgets (Tawk, etc.) to known origins only.
	const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	// Admin wallet allowlist exposed to the FE so the nav can flip on
	// the admin links the moment the user connects/switches to an admin
	// wallet — without first forcing a signed-session round-trip.
	// Knowing an address is in the list grants no privilege: every
	// admin endpoint still verifies a fresh signature against the same
	// allowlist server-side. Admin addresses are usually already public
	// on chain (deployer / owner / admin-tx history), so this isn't new
	// exposure.
	const adminWallets = (env.ADMIN_WALLETS ?? '')
		.split(',')
		.map((a) => a.trim().toLowerCase())
		.filter(Boolean);

	return {
		isAdmin: locals.isAdmin || false,
		wallet: locals.wallet || null,
		adminWallets,
		socialLinks,
		allowedOrigins,
	};
};
