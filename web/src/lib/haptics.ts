/**
 * Haptic feedback helper.
 *
 * Wraps `navigator.vibrate()` with a small set of named patterns and a
 * runtime opt-out so we never spam the device. iOS Safari ignores the
 * Vibration API silently — Android responds. Calls cost nothing on
 * unsupported platforms; no need to feature-detect at the call site.
 */

const STORAGE_KEY = 'haptics_disabled';

function enabled(): boolean {
	if (typeof window === 'undefined') return false;
	if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
	try {
		if (localStorage.getItem(STORAGE_KEY) === '1') return false;
	} catch {}
	// Reduced-motion preference is the right signal for "stop poking the device".
	try {
		if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
	} catch {}
	return true;
}

function fire(pattern: number | number[]) {
	if (!enabled()) return;
	try {
		navigator.vibrate(pattern);
	} catch {}
}

/** Light tap — nav switch, checkbox toggle, low-importance taps. */
export function tap(): void { fire(6); }

/** Tick — list scroll snap, slider step. */
export function tick(): void { fire(3); }

/** Success — tx confirmed, copy succeeded. */
export function success(): void { fire([8, 40, 12]); }

/** Warning / error — input invalid, soft revert. */
export function warn(): void { fire([18, 60, 18]); }

/** Long press recognition. */
export function longPress(): void { fire(14); }

export function setHapticsEnabled(on: boolean): void {
	if (typeof window === 'undefined') return;
	try {
		if (on) localStorage.removeItem(STORAGE_KEY);
		else localStorage.setItem(STORAGE_KEY, '1');
	} catch {}
}

export function hapticsEnabled(): boolean { return enabled(); }
