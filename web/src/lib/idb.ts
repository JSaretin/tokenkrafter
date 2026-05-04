/**
 * Tiny IndexedDB helper — generic key/value persistence with TTL.
 *
 * Used by tokenLogo (resolved logos), tradeLens (warm token cache),
 * and quote cache. Each subsystem gets its own object store.
 *
 * Why not localStorage:
 *  - Bigger quota (~50 MB vs ~5 MB) — the chain-tokens list and pool
 *    cache for 3k+ tokens would push localStorage limits on power
 *    users with multiple chains.
 *  - Async API doesn't block the main thread on reads/writes.
 *
 * Why not the `idb` npm package:
 *  - We need ~30 lines of API; the dep isn't worth the bytes.
 *  - SSR-safe wrappers below no-op when `indexedDB` is undefined so
 *    nothing breaks during SvelteKit prerender.
 *
 * Layout: stored values are wrapped as `{ v, ts, ttl }`. `ts` is the
 * write time, `ttl` is the freshness window in ms (0 = never expires).
 * Reads after `ts + ttl` resolve to null and fire-and-forget delete the
 * stale row, so the store self-trims for popular keys.
 */

const DB_NAME = 'tokenkrafter';
const DB_VERSION = 1;
const STORES = ['logos', 'tradelens', 'quotes'] as const;
export type IdbStore = (typeof STORES)[number];

interface Wrapped<T> {
	v: T;
	ts: number;
	ttl: number;
}

let _db: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
	if (typeof indexedDB === 'undefined') return Promise.resolve(null);
	if (_db) return _db;
	_db = new Promise<IDBDatabase | null>((resolve) => {
		try {
			const req = indexedDB.open(DB_NAME, DB_VERSION);
			req.onupgradeneeded = () => {
				const db = req.result;
				for (const name of STORES) {
					if (!db.objectStoreNames.contains(name)) {
						db.createObjectStore(name);
					}
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => resolve(null);
			req.onblocked = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
	return _db;
}

/**
 * Read a value. Returns null on miss, expired entry, or any IDB
 * failure — callers should treat IDB as opportunistic.
 */
export async function idbGet<T>(store: IdbStore, key: string): Promise<T | null> {
	const db = await openDb();
	if (!db) return null;
	return new Promise<T | null>((resolve) => {
		try {
			const tx = db.transaction(store, 'readonly');
			const req = tx.objectStore(store).get(key);
			req.onsuccess = () => {
				const wrapped = req.result as Wrapped<T> | undefined;
				if (!wrapped) return resolve(null);
				if (wrapped.ttl > 0 && Date.now() - wrapped.ts > wrapped.ttl) {
					// Stale — fire-and-forget delete so the store self-trims.
					idbDel(store, key);
					return resolve(null);
				}
				resolve(wrapped.v);
			};
			req.onerror = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}

/**
 * Write a value with optional TTL (ms). 0 / undefined = no expiry.
 * Returns silently on failure — IDB is opportunistic.
 */
export async function idbSet<T>(store: IdbStore, key: string, value: T, ttlMs = 0): Promise<void> {
	const db = await openDb();
	if (!db) return;
	return new Promise<void>((resolve) => {
		try {
			const tx = db.transaction(store, 'readwrite');
			const wrapped: Wrapped<T> = { v: value, ts: Date.now(), ttl: ttlMs };
			tx.objectStore(store).put(wrapped, key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
			tx.onabort = () => resolve();
		} catch {
			resolve();
		}
	});
}

export async function idbDel(store: IdbStore, key: string): Promise<void> {
	const db = await openDb();
	if (!db) return;
	return new Promise<void>((resolve) => {
		try {
			const tx = db.transaction(store, 'readwrite');
			tx.objectStore(store).delete(key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
		} catch {
			resolve();
		}
	});
}
