import { writable } from 'svelte/store';

export interface OnrampOpenParams {
	/** Pre-fill NGN amount (whole naira, not kobo). */
	ngnAmount?: number;
	/** Optional: override receiver address. Defaults to active user wallet. */
	receiver?: string;
	/** Fired after USDT is confirmed delivered. */
	onSuccess?: (txHash: string) => void;
}

const _state = writable<OnrampOpenParams | null>(null);

/**
 * Singleton on-ramp store. Mount <OnrampModal /> once on a page;
 * any caller can open it via `onrampStore.open({...})`.
 */
export const onrampStore = {
	subscribe: _state.subscribe,
	open(params: OnrampOpenParams = {}) {
		_state.set(params);
	},
	close() {
		_state.set(null);
	},
};
