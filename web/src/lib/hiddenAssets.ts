import { writable, derived, type Readable } from 'svelte/store';
import { activeAccountKey } from './activeAccount';

/**
 * Per-account hidden asset list.
 *
 * Storage shape: `{ "<account-addr>": ["<token-addr>", ...] }`. The
 * subscribe surface reflects the slice for the currently-active
 * account (driven by `activeAccountKey`); switching account swaps
 * the visible list with no remount.
 */

const STORAGE_KEY = 'hidden_assets_by_account';
const LEGACY_KEY = 'hidden_assets';

type AllMap = Record<string, string[]>;

function loadAll(): AllMap {
	if (typeof window === 'undefined') return {};
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				const out: AllMap = {};
				for (const [k, v] of Object.entries(parsed)) {
					if (Array.isArray(v)) {
						out[k.toLowerCase()] = v.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
					}
				}
				return out;
			}
		}
	} catch {}
	return {};
}

function saveAll(m: AllMap) {
	if (typeof window === 'undefined') return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(m));
	} catch {}
}

let _all: AllMap = loadAll();
let _currentKey = '';

const _activeView = writable<string[]>([]);
const _allView = writable<AllMap>(_all);

function emitActive() {
	_activeView.set(_all[_currentKey] ? [..._all[_currentKey]] : []);
}
function emitAll() {
	_allView.set({ ..._all });
}

if (typeof window !== 'undefined') {
	activeAccountKey.subscribe((k) => {
		_currentKey = (k || '').toLowerCase();
		// One-time legacy migration: the first active account on a device
		// that has the old global "hidden_assets" key inherits its list.
		// Subsequent account switches don't re-inherit; the legacy key is
		// removed after the first migration so accounts start clean.
		if (_currentKey && !_all[_currentKey]) {
			try {
				const legacy = localStorage.getItem(LEGACY_KEY);
				if (legacy) {
					const parsed = JSON.parse(legacy);
					if (Array.isArray(parsed) && parsed.length > 0) {
						_all = {
							..._all,
							[_currentKey]: parsed.filter((x: unknown): x is string => typeof x === 'string').map((x) => x.toLowerCase()),
						};
						saveAll(_all);
						emitAll();
					}
					localStorage.removeItem(LEGACY_KEY);
				}
			} catch {}
		}
		emitActive();
	});
}

export const hiddenAssets: Readable<string[]> = { subscribe: _activeView.subscribe };

/** Full per-account map — used by the cross-device prefs sync watcher. */
export const hiddenAssetsAll: Readable<AllMap> = { subscribe: _allView.subscribe };

export function hideAsset(address: string) {
	if (!_currentKey) return;
	const addr = address.toLowerCase();
	const arr = _all[_currentKey] || [];
	if (arr.includes(addr)) return;
	_all = { ..._all, [_currentKey]: [...arr, addr] };
	saveAll(_all);
	emitActive();
	emitAll();
}

export function unhideAsset(address: string) {
	if (!_currentKey) return;
	const addr = address.toLowerCase();
	const arr = _all[_currentKey] || [];
	if (!arr.includes(addr)) return;
	_all = { ..._all, [_currentKey]: arr.filter((a) => a !== addr) };
	saveAll(_all);
	emitActive();
	emitAll();
}

export function toggleHidden(address: string) {
	if (!_currentKey) return;
	const addr = address.toLowerCase();
	const arr = _all[_currentKey] || [];
	const next = arr.includes(addr) ? arr.filter((a) => a !== addr) : [...arr, addr];
	_all = { ..._all, [_currentKey]: next };
	saveAll(_all);
	emitActive();
	emitAll();
}

export function isHidden(address: string): Readable<boolean> {
	return derived(hiddenAssets, ($h) => $h.includes(address.toLowerCase()));
}

/** Re-read all per-account slices from localStorage. Called after a
 *  cross-device preferences restore writes new values. */
export function hydrateHiddenAssets() {
	if (typeof window === 'undefined') return;
	_all = loadAll();
	emitActive();
	emitAll();
}

/** Full snapshot for cross-device sync. Replaces the previous single-list
 *  serializer — the server now stores the per-account map verbatim. */
export function serializeHiddenAssetsAll(): AllMap {
	return _all;
}

/** Apply a server-issued per-account map (called from restorePreferences). */
export function applyHiddenAssetsAll(m: AllMap) {
	if (typeof window === 'undefined') return;
	const out: AllMap = {};
	for (const [k, v] of Object.entries(m || {})) {
		if (Array.isArray(v)) {
			out[k.toLowerCase()] = v.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
		}
	}
	_all = out;
	saveAll(_all);
	emitActive();
	emitAll();
}
