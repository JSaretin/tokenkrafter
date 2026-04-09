/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE_NAME = `tk-cache-${version}`;
const API_CACHE_NAME = 'tk-api-cache';

// Assets to precache: built JS/CSS + static files (fonts, icons, manifest)
const PRECACHE = [
	...build,
	...files.filter(f =>
		f.endsWith('.woff2') ||
		f.endsWith('.svg') ||
		f.endsWith('.json') ||
		f === '/robots.txt'
	),
];

// API routes to cache with stale-while-revalidate + TTL (in seconds)
const API_CACHE_RULES: Record<string, number> = {
	'/api/bank': 86400,              // bank list — 24h
	'/api/rates': 300,               // exchange rates — 5min
	'/api/platform-stats': 600,      // platform stats — 10min
	'/api/token-metadata': 3600,     // token metadata — 1h
	'/api/launches': 120,            // launch list — 2min
	'/api/recent-transactions': 60,  // recent txs — 1min
};

// Install: precache app shell
sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).then(() => sw.skipWaiting())
	);
});

// Activate: clean old asset caches (keep API cache)
sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys().then((keys) =>
			Promise.all(
				keys
					.filter((k) => k !== CACHE_NAME && k !== API_CACHE_NAME)
					.map((k) => caches.delete(k))
			)
		).then(() => sw.clients.claim())
	);
});

// Check if an API cache entry is still fresh
function isApiFresh(response: Response, maxAge: number): boolean {
	const cached = response.headers.get('sw-cached-at');
	if (!cached) return false;
	return (Date.now() - parseInt(cached)) < maxAge * 1000;
}

// Clone response with a timestamp header
async function tagResponse(response: Response): Promise<Response> {
	const body = await response.arrayBuffer();
	const headers = new Headers(response.headers);
	headers.set('sw-cached-at', String(Date.now()));
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

// Find matching API cache rule
function getApiCacheTTL(pathname: string): number | null {
	// Exact match first
	if (API_CACHE_RULES[pathname]) return API_CACHE_RULES[pathname];
	// Prefix match (e.g. /api/token-metadata?address=0x...)
	for (const [route, ttl] of Object.entries(API_CACHE_RULES)) {
		if (pathname.startsWith(route)) return ttl;
	}
	return null;
}

// Notify all clients about online/offline status
function notifyClients(type: string, data?: any) {
	sw.clients.matchAll({ type: 'window' }).then((clients) => {
		for (const client of clients) {
			client.postMessage({ type, ...data });
		}
	});
}

// Fetch handler
sw.addEventListener('fetch', (event) => {
	const { request } = event;
	const url = new URL(request.url);

	// Skip non-GET and cross-origin
	if (request.method !== 'GET') return;
	if (url.origin !== sw.location.origin) return;

	// API routes: stale-while-revalidate with TTL
	if (url.pathname.startsWith('/api/')) {
		const ttl = getApiCacheTTL(url.pathname);
		if (ttl === null) return; // no caching for this API route

		event.respondWith(
			caches.open(API_CACHE_NAME).then(async (cache) => {
				const cacheKey = request.url;
				const cached = await cache.match(cacheKey);

				// If cached and fresh, return from cache — no background fetch
				if (cached && isApiFresh(cached, ttl)) {
					return cached;
				}

				// Not cached or stale — try network
				try {
					const response = await fetch(request);
					if (response.ok) {
						cache.put(cacheKey, await tagResponse(response.clone()));
					}
					return response;
				} catch {
					// Network failed — return stale cache if available
					if (cached) return cached;
					return new Response(JSON.stringify({ error: 'offline' }), {
						status: 503,
						headers: { 'Content-Type': 'application/json' },
					});
				}
			})
		);
		return;
	}

	// Navigation requests: network first, fall back to cached shell
	if (request.mode === 'navigate') {
		event.respondWith(
			fetch(request)
				.then((response) => {
					const clone = response.clone();
					caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
					notifyClients('online');
					return response;
				})
				.catch(() => {
					notifyClients('offline');
					return caches.match(request).then((cached) => cached || caches.match('/')) as Promise<Response>;
				})
		);
		return;
	}

	// Static assets: cache first, network fallback
	event.respondWith(
		caches.match(request).then((cached) => {
			if (cached) return cached;
			return fetch(request).then((response) => {
				if (response.ok && (url.pathname.startsWith('/_app/') || url.pathname.startsWith('/fonts/'))) {
					const clone = response.clone();
					caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
				}
				return response;
			});
		}) as Promise<Response>
	);
});
