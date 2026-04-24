import { writable, derived, type Readable } from 'svelte/store';

const STORAGE_KEY = 'hidden_assets';

function load(): string[] {
	if (typeof window === 'undefined') return [];
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return parsed.filter((a: unknown) => typeof a === 'string').map((a) => (a as string).toLowerCase());
		}
	} catch {}
	return [];
}

export const hiddenAssets = writable<string[]>(load());

hiddenAssets.subscribe((val) => {
	if (typeof window === 'undefined') return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(val));
	} catch {}
});

export function hideAsset(address: string) {
	const addr = address.toLowerCase();
	hiddenAssets.update((arr) => (arr.includes(addr) ? arr : [...arr, addr]));
}

export function unhideAsset(address: string) {
	const addr = address.toLowerCase();
	hiddenAssets.update((arr) => arr.filter((a) => a !== addr));
}

export function toggleHidden(address: string) {
	const addr = address.toLowerCase();
	hiddenAssets.update((arr) => (arr.includes(addr) ? arr.filter((a) => a !== addr) : [...arr, addr]));
}

export function isHidden(address: string): Readable<boolean> {
	return derived(hiddenAssets, ($h) => $h.includes(address.toLowerCase()));
}

/** Re-read the store from localStorage. Used after a cross-device
 *  preferences restore has written fresh values to storage. */
export function hydrateHiddenAssets() {
	if (typeof window === 'undefined') return;
	hiddenAssets.set(load());
}

/** Serialize the current value for server-side preferences persistence. */
export function serializeHiddenAssets(): string[] {
	let snapshot: string[] = [];
	hiddenAssets.subscribe((v) => (snapshot = v))();
	return snapshot;
}
