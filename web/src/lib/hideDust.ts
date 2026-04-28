import { writable, type Readable } from 'svelte/store';
import { activeAccountKey } from './activeAccount';

/**
 * Per-account hide-small-balances toggle.
 *
 * Storage shape: `{ "<account-addr>": true|false }`. Subscribers see
 * the slice for the currently-active account.
 */

const STORAGE_KEY = 'hide_dust_by_account';
const LEGACY_KEY = 'hide_dust';
export const DUST_USD_THRESHOLD = 0.10;

type AllMap = Record<string, boolean>;

function loadAll(): AllMap {
	if (typeof window === 'undefined') return {};
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				const out: AllMap = {};
				for (const [k, v] of Object.entries(parsed)) {
					out[k.toLowerCase()] = v === true;
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

const _activeView = writable<boolean>(false);
const _allView = writable<AllMap>(_all);

function emitActive() {
	_activeView.set(!!_all[_currentKey]);
}
function emitAll() {
	_allView.set({ ..._all });
}

if (typeof window !== 'undefined') {
	activeAccountKey.subscribe((k) => {
		_currentKey = (k || '').toLowerCase();
		// One-time legacy migration: first active account inherits the old
		// global "hide_dust" boolean, then the legacy key is removed.
		if (_currentKey && _all[_currentKey] === undefined) {
			try {
				const legacy = localStorage.getItem(LEGACY_KEY);
				if (legacy !== null) {
					_all = { ..._all, [_currentKey]: legacy === '1' };
					saveAll(_all);
					emitAll();
					localStorage.removeItem(LEGACY_KEY);
				}
			} catch {}
		}
		emitActive();
	});
}

function setActive(v: boolean) {
	if (!_currentKey) return;
	_all = { ..._all, [_currentKey]: v };
	saveAll(_all);
	emitActive();
	emitAll();
}

export const hideDust: { subscribe: Readable<boolean>['subscribe']; set: (v: boolean) => void; update: (fn: (v: boolean) => boolean) => void } = {
	subscribe: _activeView.subscribe,
	set: setActive,
	update: (fn) => {
		const prev = !!_all[_currentKey];
		setActive(fn(prev));
	},
};

/** Full per-account map — used by the cross-device prefs sync watcher. */
export const hideDustAll: Readable<AllMap> = { subscribe: _allView.subscribe };

export function setHideDust(v: boolean) {
	setActive(v);
}

export function hydrateHideDust() {
	if (typeof window === 'undefined') return;
	_all = loadAll();
	emitActive();
	emitAll();
}

export function serializeHideDustAll(): AllMap {
	return _all;
}

export function applyHideDustAll(m: AllMap) {
	if (typeof window === 'undefined') return;
	const out: AllMap = {};
	for (const [k, v] of Object.entries(m || {})) out[k.toLowerCase()] = v === true;
	_all = out;
	saveAll(_all);
	emitActive();
	emitAll();
}
