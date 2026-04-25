<script lang="ts">
	/**
	 * SuccessBurst — celebratory confirmation indicator. Renders a cyan
	 * checkmark pill that scales in with a subtle overshoot, surrounded by
	 * 8 small spark dots that puff outward and fade. Total runtime ~700ms.
	 *
	 * Trigger by flipping `show` from false → true. After the animation
	 * finishes the component calls `onComplete?.()` and resets so the
	 * caller can re-fire it later by toggling `show`.
	 *
	 * Reduced motion: the burst is suppressed entirely; only the static
	 * checkmark pill is shown while `show` is true.
	 */
	import { success as hapticSuccess } from './haptics';
	import { prefersReducedMotion } from './animations';

	let {
		show,
		onComplete,
	}: {
		show: boolean;
		onComplete?: () => void;
	} = $props();

	const TOTAL_MS = 700;
	const SPARK_COUNT = 8;

	// Sparks pre-computed once; angle is uniform around the circle, with
	// a slight magnitude jitter so it doesn't look like a clock face.
	const sparks = Array.from({ length: SPARK_COUNT }, (_, i) => {
		const angle = (i / SPARK_COUNT) * Math.PI * 2 - Math.PI / 2;
		const distance = 22 + ((i * 7) % 6); // 22..27px outward
		const dx = Math.cos(angle) * distance;
		const dy = Math.sin(angle) * distance;
		const delay = (i % 3) * 25; // micro-stagger so they don't fire in lockstep
		return { dx, dy, delay };
	});

	let playing = $state(false);
	let reduced = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;

	function clearTimer() {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	}

	$effect(() => {
		if (!show) {
			clearTimer();
			playing = false;
			return;
		}
		reduced = prefersReducedMotion();
		playing = true;
		try {
			hapticSuccess();
		} catch {}
		clearTimer();
		timer = setTimeout(() => {
			playing = false;
			timer = null;
			onComplete?.();
		}, TOTAL_MS);
	});

	$effect(() => {
		return () => clearTimer();
	});
</script>

{#if show}
	<span class="success-burst" class:reduced aria-hidden="true">
		<span class="check-pill" class:playing>
			<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
				<polyline points="5 12 10 17 19 7" />
			</svg>
		</span>
		{#if !reduced && playing}
			{#each sparks as s, i (i)}
				<span
					class="spark"
					style="--dx:{s.dx}px; --dy:{s.dy}px; --delay:{s.delay}ms;"
				></span>
			{/each}
		{/if}
	</span>
{/if}

<style>
	.success-burst {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		pointer-events: none;
	}

	.check-pill {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: 999px;
		background: rgba(0, 210, 255, 0.14);
		color: #00d2ff;
		border: 1px solid rgba(0, 210, 255, 0.35);
		box-shadow: 0 0 18px rgba(0, 210, 255, 0.35);
		transform: scale(1);
	}

	.check-pill.playing {
		animation: burst-pop 520ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
	}

	@keyframes burst-pop {
		0% {
			transform: scale(0);
			opacity: 0;
		}
		60% {
			transform: scale(1.12);
			opacity: 1;
		}
		100% {
			transform: scale(1);
			opacity: 1;
		}
	}

	.spark {
		position: absolute;
		left: 50%;
		top: 50%;
		width: 4px;
		height: 4px;
		margin-left: -2px;
		margin-top: -2px;
		border-radius: 999px;
		background: #00d2ff;
		box-shadow: 0 0 6px rgba(0, 210, 255, 0.8);
		opacity: 0;
		animation: spark-fly 600ms cubic-bezier(0.22, 1, 0.36, 1) both;
		animation-delay: var(--delay, 0ms);
	}

	@keyframes spark-fly {
		0% {
			transform: translate(0, 0) scale(0.6);
			opacity: 0;
		}
		20% {
			opacity: 1;
		}
		100% {
			transform: translate(var(--dx), var(--dy)) scale(0.4);
			opacity: 0;
		}
	}

	.success-burst.reduced .check-pill.playing {
		animation: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.check-pill.playing {
			animation: none;
		}
		.spark {
			animation: none;
			opacity: 0;
		}
	}
</style>
