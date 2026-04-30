/**
 * GET /api/avatar/x/[username]
 *
 * Cached redirect to unavatar.io. Used by the team page (and any
 * future "user from X" surface) so we don't hit the X API directly
 * — Free tier is 100 reads/month, Basic is $200/month.
 *
 * Why a 302 redirect instead of streaming the bytes through our
 * worker: a streaming proxy worked locally but consistently returned
 * 502 on Cloudflare Pages — both endpoints sit behind Cloudflare and
 * worker→unavatar fetch in this shape was being blocked or dropped
 * (CF loop-prevention or upstream WAF). A redirect sidesteps that
 * entirely: the browser follows once, caches the image (unavatar
 * itself sets max-age=2419200 = 28 days), subsequent loads are
 * cache hits. The redirect itself also carries a long Cache-Control
 * so even the 302 caches at the CF edge.
 *
 * The indirection layer is preserved: callers still hit
 * /api/avatar/x/<user>, so swapping upstream later (Gravatar,
 * R2-backed uploads, etc.) is a single-file change.
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const X_USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;

export const GET: RequestHandler = async ({ params }) => {
	const username = params.username ?? '';
	if (!X_USERNAME_RE.test(username)) return error(400, 'Invalid X username');

	return new Response(null, {
		status: 302,
		headers: {
			Location: `https://unavatar.io/x/${encodeURIComponent(username)}?fallback=false`,
			'Cache-Control':
				'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=2592000',
		},
	});
};
