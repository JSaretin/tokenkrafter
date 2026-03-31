import { writable, derived } from 'svelte/store';

const STORAGE_KEY = 'launch_favorites';

function loadFavorites(): string[] {
	if (typeof window === 'undefined') return [];
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed.filter((a: unknown) => typeof a === 'string');
	} catch {}
	return [];
}

export const favorites = writable<string[]>(loadFavorites());

// Persist on every change
favorites.subscribe((val) => {
	if (typeof window === 'undefined') return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(val));
	} catch {}
});

export function toggleFavorite(address: string) {
	const addr = address.toLowerCase();
	favorites.update((arr) => {
		if (arr.includes(addr)) {
			return arr.filter((a) => a !== addr);
		}
		return [...arr, addr];
	});
}

export function isFavorite(address: string) {
	return derived(favorites, ($favorites) => $favorites.includes(address.toLowerCase()));
}
