/**
 * TokenKrafter service worker — minimal shell cache for app-feel.
 *
 * Strategy:
 *   - Static assets (icons, manifest, fonts): cache-first, fallback network.
 *   - Navigations (HTML pages): network-first with cache fallback.
 *   - API/RPC/external: never cached, never intercepted.
 *
 * The point isn't full offline — it's a snappier second-load. Subsequent
 * visits paint the shell from cache while SvelteKit hydrates in
 * parallel.
 *
 * Bump CACHE_VERSION whenever the cached asset list changes shape. Old
 * caches are pruned on activate.
 */

const CACHE_VERSION = 'tk-shell-v1';
const SHELL = [
	'/',
	'/manifest.json',
	'/favicon.svg',
	'/favicon-32.png',
	'/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE_VERSION)
			.then((cache) => cache.addAll(SHELL).catch(() => {}))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
			)
			.then(() => self.clients.claim()),
	);
});

self.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;

	const url = new URL(req.url);

	// Same-origin only — never proxy third-party RPC, GeckoTerminal, IPFS, etc.
	if (url.origin !== self.location.origin) return;

	// Don't cache API / SvelteKit data routes / OG generator / Supabase auth.
	if (url.pathname.startsWith('/api/')) return;
	if (url.pathname.startsWith('/_app/data/')) return;
	if (url.pathname.startsWith('/auth/')) return;

	// Navigations: network-first.
	if (req.mode === 'navigate') {
		event.respondWith(
			fetch(req)
				.then((res) => {
					const copy = res.clone();
					caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
					return res;
				})
				.catch(() => caches.match(req).then((m) => m || caches.match('/'))),
		);
		return;
	}

	// Static assets: cache-first.
	if (
		url.pathname.startsWith('/_app/immutable/') ||
		url.pathname.startsWith('/brand/') ||
		/\.(svg|png|jpe?g|webp|woff2?|ttf|css|js|ico)$/i.test(url.pathname)
	) {
		event.respondWith(
			caches.match(req).then((cached) => {
				if (cached) return cached;
				return fetch(req).then((res) => {
					if (res.ok) {
						const copy = res.clone();
						caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
					}
					return res;
				});
			}),
		);
	}
});
