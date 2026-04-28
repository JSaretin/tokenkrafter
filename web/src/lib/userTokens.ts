import { writable, derived, type Readable } from 'svelte/store';
import { activeAccountKey } from './activeAccount';
import { isDeletedAddress } from './deletedTokens';

const STORAGE_KEY = 'user_imported_tokens_by_account';
const LEGACY_KEYS = ['user_imported_tokens', 'imported_tokens', 'importedTokens'] as const;

export interface UserToken {
	address: string;
	symbol: string;
	name: string;
	decimals: number;
	logoUrl?: string;
	chainId: number;
}

type AllMap = Record<string, UserToken[]>;

const norm = (a: string) => a.toLowerCase();
const keyOf = (chainId: number, addr: string) => `${chainId}:${norm(addr)}`;

function parseTokens(raw: unknown, fallbackChainId = 56): UserToken[] {
	if (!Array.isArray(raw)) return [];
	const out: UserToken[] = [];
	const seen = new Set<string>();
	for (const r of raw as Record<string, unknown>[]) {
		if (!r || typeof r !== 'object') continue;
		const addrRaw = typeof r.address === 'string' ? r.address : '';
		if (!addrRaw) continue;
		const chainId = Number(r.chainId ?? fallbackChainId) || fallbackChainId;
		const k = keyOf(chainId, addrRaw);
		if (seen.has(k)) continue;
		seen.add(k);
		out.push({
			address: norm(addrRaw),
			symbol: typeof r.symbol === 'string' && r.symbol ? r.symbol : '???',
			name: typeof r.name === 'string' && r.name ? r.name : (typeof r.symbol === 'string' ? r.symbol : 'Unknown'),
			decimals: Number(r.decimals ?? 18) || 18,
			logoUrl: typeof r.logoUrl === 'string' ? r.logoUrl : (typeof r.logo_url === 'string' ? r.logo_url : ''),
			chainId,
		});
	}
	return out;
}

function loadAll(): AllMap {
	if (typeof window === 'undefined') return {};
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				const out: AllMap = {};
				for (const [k, v] of Object.entries(parsed)) {
					out[k.toLowerCase()] = parseTokens(v);
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

function readLegacyTokens(): UserToken[] {
	if (typeof window === 'undefined') return [];
	const seen = new Set<string>();
	const out: UserToken[] = [];
	for (const lk of LEGACY_KEYS) {
		try {
			const raw = localStorage.getItem(lk);
			if (!raw) continue;
			const arr = parseTokens(JSON.parse(raw));
			for (const t of arr) {
				const k = keyOf(t.chainId, t.address);
				if (seen.has(k)) continue;
				seen.add(k);
				out.push(t);
			}
		} catch {}
	}
	return out;
}

let _all: AllMap = loadAll();
let _currentKey = '';

const _activeView = writable<UserToken[]>([]);
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
		// Legacy migration: first active account inherits anything from the
		// pre-per-account global keys. Legacy keys are then removed.
		if (_currentKey && !_all[_currentKey]) {
			const legacy = readLegacyTokens();
			if (legacy.length > 0) {
				_all = { ..._all, [_currentKey]: legacy };
				saveAll(_all);
				emitAll();
			}
			for (const lk of LEGACY_KEYS) {
				try { localStorage.removeItem(lk); } catch {}
			}
		}
		emitActive();
	});
}

export const userTokens: Readable<UserToken[]> = { subscribe: _activeView.subscribe };

/** Full per-account map — used by the cross-device prefs sync watcher. */
export const userTokensAll: Readable<AllMap> = { subscribe: _allView.subscribe };

export function addUserToken(token: UserToken) {
	if (!_currentKey) return;
	// Respect explicit user deletions: auto-import (poller, created-tokens
	// fetch, stablecoin auto-pin) shouldn't undo a Delete action. The
	// import modal calls unmarkDeleted() before addUserToken, so manual
	// re-imports bypass this gate.
	if (isDeletedAddress(token.address)) return;
	const arr = _all[_currentKey] || [];
	if (arr.find((t) => t.chainId === token.chainId && norm(t.address) === norm(token.address))) return;
	const next = [...arr, { ...token, address: norm(token.address) }];
	_all = { ..._all, [_currentKey]: next };
	saveAll(_all);
	emitActive();
	emitAll();
}

export function updateUserToken(address: string, chainId: number, patch: Partial<UserToken>) {
	if (!_currentKey) return;
	const addr = norm(address);
	const arr = _all[_currentKey] || [];
	const next = arr.map((t) =>
		t.chainId === chainId && norm(t.address) === addr
			? { ...t, ...patch, address: norm(patch.address ?? t.address) }
			: t
	);
	_all = { ..._all, [_currentKey]: next };
	saveAll(_all);
	emitActive();
	emitAll();
}

export function removeUserToken(address: string, chainId: number) {
	if (!_currentKey) return;
	const addr = norm(address);
	const arr = _all[_currentKey] || [];
	const next = arr.filter((t) => !(t.chainId === chainId && norm(t.address) === addr));
	_all = { ..._all, [_currentKey]: next };
	saveAll(_all);
	emitActive();
	emitAll();
}

export function getUserTokensForChain(chainId: number): Readable<UserToken[]> {
	return derived(userTokens, ($t) => $t.filter((t) => t.chainId === chainId));
}

export function hydrateUserTokens() {
	if (typeof window === 'undefined') return;
	_all = loadAll();
	emitActive();
	emitAll();
}

export function serializeUserTokensAll(): AllMap {
	return _all;
}

export function applyUserTokensAll(m: AllMap) {
	if (typeof window === 'undefined') return;
	const out: AllMap = {};
	for (const [k, v] of Object.entries(m || {})) out[k.toLowerCase()] = parseTokens(v);
	_all = out;
	saveAll(_all);
	emitActive();
	emitAll();
}
