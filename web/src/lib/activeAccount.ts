/**
 * Tracks the currently-active wallet account address. Per-account
 * preferences (hidden assets, hide-dust, imported tokens) subscribe
 * to this and re-emit their account-scoped slice on switch.
 *
 * Layout drives this from the canonical `userAddress` so it works for
 * both embedded wallets (where the address comes from the embedded
 * wallet's active account) and external wallets (where it comes from
 * wagmi).
 */
import { writable } from 'svelte/store';

export const activeAccountKey = writable<string>('');

export function setActiveAccountKey(addr: string) {
	activeAccountKey.set((addr || '').toLowerCase());
}
