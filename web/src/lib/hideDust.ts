import { writable } from 'svelte/store';

const STORAGE_KEY = 'hide_dust';
export const DUST_USD_THRESHOLD = 0.10;

function load(): boolean {
	if (typeof window === 'undefined') return false;
	try {
		return localStorage.getItem(STORAGE_KEY) === '1';
	} catch {
		return false;
	}
}

export const hideDust = writable<boolean>(load());

hideDust.subscribe((v) => {
	if (typeof window === 'undefined') return;
	try {
		localStorage.setItem(STORAGE_KEY, v ? '1' : '0');
	} catch {}
});

export function setHideDust(v: boolean) {
	hideDust.set(v);
}

export function hydrateHideDust() {
	if (typeof window === 'undefined') return;
	hideDust.set(load());
}

export function serializeHideDust(): boolean {
	let snap = false;
	hideDust.subscribe((v) => (snap = v))();
	return snap;
}
