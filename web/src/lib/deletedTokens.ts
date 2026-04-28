import { writable, type Readable } from 'svelte/store';
import { activeAccountKey } from './activeAccount';

/**
 * Per-account "do not auto-import" set.
 *
 * When the user explicitly deletes an imported token via the long-press
 * action sheet, the address goes here so the balance poller's
 * auto-discovery and the wallet's auto-pin/auto-import paths stop
 * re-adding it. Re-importing through the modal removes it from this set.
 *
 * Storage shape: `{ "<account-addr>": ["<token-addr>", ...] }`. Same
 * scope-on-active-account pattern as hiddenAssets / hideDust /
 * userTokens, so a deletion on account A doesn't block auto-import on
 * account B.
 */

const STORAGE_KEY = 'deleted_tokens_by_account';

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
		emitActive();
	});
}

export const deletedTokens: Readable<string[]> = { subscribe: _activeView.subscribe };

/** Full per-account map — used by the cross-device prefs sync watcher. */
export const deletedTokensAll: Readable<AllMap> = { subscribe: _allView.subscribe };

/** Synchronous read used by addUserToken to gate inserts. */
export function isDeletedAddress(address: string): boolean {
	if (!_currentKey) return false;
	const list = _all[_currentKey];
	return !!list && list.includes(address.toLowerCase());
}

export function markDeleted(address: string) {
	if (!_currentKey) return;
	const addr = address.toLowerCase();
	const arr = _all[_currentKey] || [];
	if (arr.includes(addr)) return;
	_all = { ..._all, [_currentKey]: [...arr, addr] };
	saveAll(_all);
	emitActive();
	emitAll();
}

export function unmarkDeleted(address: string) {
	if (!_currentKey) return;
	const addr = address.toLowerCase();
	const arr = _all[_currentKey] || [];
	if (!arr.includes(addr)) return;
	_all = { ..._all, [_currentKey]: arr.filter((a) => a !== addr) };
	saveAll(_all);
	emitActive();
	emitAll();
}

export function hydrateDeletedTokens() {
	if (typeof window === 'undefined') return;
	_all = loadAll();
	emitActive();
	emitAll();
}

export function serializeDeletedTokensAll(): AllMap {
	return _all;
}

export function applyDeletedTokensAll(m: AllMap) {
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
