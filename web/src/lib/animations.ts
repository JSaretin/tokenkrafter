/**
 * Tiny animation helpers shared by `AnimatedNumber.svelte` and
 * `SuccessBurst.svelte`. Kept dependency-free so any component can pull
 * these in without dragging svelte/motion or extra easings into the bundle.
 */

/** Cubic ease-out — fast settle, slow finish. Good default for value tweens. */
export function easeOutCubic(t: number): number {
	const x = t < 0 ? 0 : t > 1 ? 1 : t;
	const inv = 1 - x;
	return 1 - inv * inv * inv;
}

/**
 * Cubic ease-in-out — for panel/scale movement that needs symmetry.
 * Provided for completeness; AnimatedNumber uses ease-out by default.
 */
export function easeInOutCubic(t: number): number {
	const x = t < 0 ? 0 : t > 1 ? 1 : t;
	return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * Returns true when the user has requested reduced motion. Safe to call
 * during SSR — returns false if `window` is unavailable.
 */
export function prefersReducedMotion(): boolean {
	if (typeof window === 'undefined') return false;
	try {
		return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
	} catch {
		return false;
	}
}

/** Coerce bigint or number-like input to a finite number, NaN-safe. */
export function toFiniteNumber(v: number | bigint | null | undefined): number {
	if (v === null || v === undefined) return 0;
	if (typeof v === 'bigint') return Number(v);
	if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
	return 0;
}
