/**
 * GET /api/avatar/x/[username]
 *
 * Edge-cached avatar proxy backed by unavatar.io. Used by the team
 * page (and any future "user from X" surface) so we don't hit the X
 * API directly — Free tier is 100 reads/month, Basic is $200/month.
 *
 * Why proxy instead of direct unavatar URLs:
 *   - Long Cache-Control on our domain → CF edge caches per region.
 *   - Lets us swap upstreams (Gravatar, R2-stored uploads, etc.)
 *     without touching every client that renders an avatar.
 *   - One place to enforce username sanity + timeouts.
 *
 * Cache strategy:
 *   - 200: max-age=86400, s-maxage=2592000, stale-while-revalidate=2592000
 *     (1 day browser, 30 days edge, 30 day SWR — operator profile pic
 *     changes are eventual but bandwidth/cost stays near zero)
 *   - 404 (no avatar): short max-age so adding an account later
 *     becomes visible without manual cache purge.
 *   - 5xx: very short cache to retry quickly.
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// X username spec: 1-15 chars, [A-Za-z0-9_]. Reject anything else
// before we touch the upstream — keeps malformed paths off the cache.
const X_USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;

export const GET: RequestHandler = async ({ params }) => {
	const username = params.username ?? '';
	if (!X_USERNAME_RE.test(username)) return error(400, 'Invalid X username');

	let upstream: Response;
	try {
		// fallback=false makes unavatar return 404 if no avatar is found,
		// rather than serving a generic placeholder we'd then cache for
		// 30 days under the user's path.
		upstream = await fetch(`https://unavatar.io/x/${username}?fallback=false`, {
			signal: AbortSignal.timeout(5000),
			headers: { 'User-Agent': 'TokenKrafter-Avatar-Proxy/1.0' },
		});
	} catch {
		return new Response(null, {
			status: 502,
			headers: { 'Cache-Control': 'public, max-age=30' },
		});
	}

	if (upstream.status === 404) {
		return new Response(null, {
			status: 404,
			headers: { 'Cache-Control': 'public, max-age=300' },
		});
	}
	if (!upstream.ok) {
		return new Response(null, {
			status: 502,
			headers: { 'Cache-Control': 'public, max-age=30' },
		});
	}

	const bytes = await upstream.arrayBuffer();
	return new Response(bytes, {
		status: 200,
		headers: {
			'Content-Type': upstream.headers.get('content-type') ?? 'image/jpeg',
			'Cache-Control':
				'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=2592000',
		},
	});
};
