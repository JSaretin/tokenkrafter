import { writable, derived, type Readable } from 'svelte/store';

const STORAGE_KEY = 'user_imported_tokens';
const LEGACY_KEYS = ['imported_tokens', 'importedTokens'] as const;

export interface UserToken {
	address: string;
	symbol: string;
	name: string;
	decimals: number;
	logoUrl?: string;
	chainId: number;
}

const norm = (a: string) => a.toLowerCase();
const keyOf = (chainId: number, addr: string) => `${chainId}:${norm(addr)}`;

function loadUserTokens(): UserToken[] {
	if (typeof window === 'undefined') return [];
	const out: UserToken[] = [];
	const seen = new Set<string>();

	const push = (raw: unknown, fallbackChainId = 56) => {
		if (!raw || typeof raw !== 'object') return;
		const r = raw as Record<string, unknown>;
		const addrRaw = typeof r.address === 'string' ? r.address : '';
		if (!addrRaw) return;
		const chainId = Number(r.chainId ?? fallbackChainId) || fallbackChainId;
		const k = keyOf(chainId, addrRaw);
		if (seen.has(k)) return;
		seen.add(k);
		out.push({
			address: norm(addrRaw),
			symbol: typeof r.symbol === 'string' && r.symbol ? r.symbol : '???',
			name: typeof r.name === 'string' && r.name ? r.name : (typeof r.symbol === 'string' ? r.symbol : 'Unknown'),
			decimals: Number(r.decimals ?? 18) || 18,
			logoUrl: typeof r.logoUrl === 'string' ? r.logoUrl : (typeof r.logo_url === 'string' ? r.logo_url : ''),
			chainId,
		});
	};

	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) for (const t of parsed) push(t);
		}
	} catch {}

	for (const legacy of LEGACY_KEYS) {
		try {
			const raw = localStorage.getItem(legacy);
			if (!raw) continue;
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) for (const t of parsed) push(t);
		} catch {}
	}

	return out;
}

export const userTokens = writable<UserToken[]>(loadUserTokens());

userTokens.subscribe((val) => {
	if (typeof window === 'undefined') return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(val));
	} catch {}
});

export function addUserToken(token: UserToken) {
	userTokens.update((arr) => {
		if (arr.find((t) => t.chainId === token.chainId && norm(t.address) === norm(token.address))) return arr;
		return [...arr, { ...token, address: norm(token.address) }];
	});
}

export function updateUserToken(address: string, chainId: number, patch: Partial<UserToken>) {
	const addr = norm(address);
	userTokens.update((arr) =>
		arr.map((t) =>
			t.chainId === chainId && norm(t.address) === addr
				? { ...t, ...patch, address: norm(patch.address ?? t.address) }
				: t
		)
	);
}

export function removeUserToken(address: string, chainId: number) {
	const addr = norm(address);
	userTokens.update((arr) => arr.filter((t) => !(t.chainId === chainId && norm(t.address) === addr)));
}

export function getUserTokensForChain(chainId: number): Readable<UserToken[]> {
	return derived(userTokens, ($t) => $t.filter((t) => t.chainId === chainId));
}

/** Re-read the store from localStorage. Used after a cross-device
 *  preferences restore has written fresh values to storage. */
export function hydrateUserTokens() {
	if (typeof window === 'undefined') return;
	userTokens.set(loadUserTokens());
}

/** Serialize the current value for server-side preferences persistence. */
export function serializeUserTokens(): UserToken[] {
	let snapshot: UserToken[] = [];
	userTokens.subscribe((v) => (snapshot = v))();
	return snapshot;
}
