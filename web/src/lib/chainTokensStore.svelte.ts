/**
 * Chain-tokens store — shared cache of CoinGecko-known tokens per chain.
 *
 * The data is served by /api/popular-tokens (which reads from
 * platform_config.popular_tokens, refreshed every 6h by the
 * popular-tokens-updater daemon). Multiple consumers across the app
 * (the trade-page picker today, payment-token modals later) all read
 * the same in-memory cache here, so we make exactly one network round
 * trip per chain per page session.
 *
 * Design notes:
 *  - Cache is a `$state` map keyed by lowercase chain slug. Reading
 *    `cache[slug]` inside a `$derived` tracks the dependency, so when
 *    the fetch settles consumers re-derive automatically without
 *    needing their own $effect to subscribe.
 *  - `preload(slug)` is idempotent — calls during an in-flight fetch
 *    are no-ops; calls after it lands also no-op (cached).
 *  - Failures cache an empty array so we don't retry on every consumer
 *    read; explicit re-fetch is a separate API if/when we need it.
 */

export type ChainToken = {
	address: string;
	symbol: string;
	name: string;
	rank?: number;
	logo?: string;
};

const _cache = $state<Record<string, ChainToken[]>>({});
const _inflight = new Set<string>();

/**
 * Synchronous, reactive read of the cached list for a chain. Returns
 * `[]` if the slug hasn't been preloaded yet — don't render fallback
 * UI off this; wait for `preload(slug)` to populate it (consumers
 * using `$derived` will re-run when it does).
 */
export function getChainTokens(slug: string): ChainToken[] {
	if (!slug) return [];
	return _cache[slug.toLowerCase()] || [];
}

/**
 * Kick off a fetch for the given chain. Idempotent: a second call
 * during an in-flight fetch, or after one has resolved, returns the
 * existing promise / completes immediately. Safe to call from
 * `onMount` in the root layout to warm the cache during app idle.
 */
export async function preloadChainTokens(slug: string): Promise<void> {
	if (!slug) return;
	const key = slug.toLowerCase();
	if (_cache[key] !== undefined) return;
	if (_inflight.has(key)) return;
	_inflight.add(key);
	try {
		const res = await fetch(`/api/popular-tokens?chain=${key}`);
		const data = res.ok ? await res.json() : { tokens: [] };
		_cache[key] = (data?.tokens || []) as ChainToken[];
	} catch {
		_cache[key] = [];
	} finally {
		_inflight.delete(key);
	}
}
