<script lang="ts">
	/**
	 * AnimatedNumber — smoothly tweens between numeric values when `value`
	 * changes. Drop-in replacement for static balance / price / market-cap
	 * displays. Uses a self-managed rAF loop (no svelte/motion dep) and
	 * respects `prefers-reduced-motion` by snapping to the new value.
	 *
	 * The tween is done in pure number-space; rendering passes through the
	 * caller's `format` (or a default fixed-decimals formatter). Callers who
	 * pass a bigint are responsible for any wei→display scaling beforehand;
	 * we just `Number(value)` it so unit-less counts (e.g. token counts) work.
	 */
	import { easeOutCubic, prefersReducedMotion, toFiniteNumber } from './animations';

	let {
		value,
		duration = 400,
		decimals,
		format,
		prefix = '',
		suffix = '',
	}: {
		value: number | bigint;
		duration?: number;
		decimals?: number;
		format?: (n: number) => string;
		prefix?: string;
		suffix?: string;
	} = $props();

	const target = $derived(toFiniteNumber(value));

	let displayed = $state(toFiniteNumber(value));
	let rafId = 0;
	let tweenFrom = displayed;
	let tweenTo = displayed;
	let tweenStart = 0;
	let tweenDuration = duration;

	function cancel() {
		if (rafId !== 0 && typeof cancelAnimationFrame !== 'undefined') {
			cancelAnimationFrame(rafId);
		}
		rafId = 0;
	}

	function step(now: number) {
		const elapsed = now - tweenStart;
		const t = tweenDuration <= 0 ? 1 : Math.min(1, elapsed / tweenDuration);
		const eased = easeOutCubic(t);
		displayed = tweenFrom + (tweenTo - tweenFrom) * eased;
		if (t < 1) {
			rafId = requestAnimationFrame(step);
		} else {
			displayed = tweenTo;
			rafId = 0;
		}
	}

	$effect(() => {
		const next = target;
		// SSR / no rAF — snap.
		if (typeof window === 'undefined' || typeof requestAnimationFrame === 'undefined') {
			displayed = next;
			return;
		}
		// Reduced motion or zero-duration — snap.
		if (duration <= 0 || prefersReducedMotion()) {
			cancel();
			displayed = next;
			return;
		}
		// Already at target (within float epsilon).
		if (Math.abs(displayed - next) < 1e-9) {
			displayed = next;
			return;
		}
		cancel();
		tweenFrom = displayed;
		tweenTo = next;
		tweenStart = performance.now();
		tweenDuration = duration;
		rafId = requestAnimationFrame(step);
	});

	$effect(() => {
		return () => cancel();
	});

	const rendered = $derived.by(() => {
		const n = displayed;
		if (format) return format(n);
		if (typeof decimals === 'number' && decimals >= 0) {
			return n.toLocaleString(undefined, {
				minimumFractionDigits: decimals,
				maximumFractionDigits: decimals,
			});
		}
		return n.toLocaleString();
	});
</script>

<span class="tabular-nums">{prefix}{rendered}{suffix}</span>
