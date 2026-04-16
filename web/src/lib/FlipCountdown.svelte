<script lang="ts">
	import { onMount } from 'svelte';

	let {
		days = 0,
		hours = 0,
		minutes = 0,
		seconds = 0,
		variant = 'cyan',
	}: {
		days?: number;
		hours?: number;
		minutes?: number;
		seconds?: number;
		variant?: 'cyan' | 'amber';
	} = $props();

	function pad(n: number): string {
		return String(n).padStart(2, '0');
	}

	// Each unit tracks current + previous for the flip transition
	let mounted = false;
	onMount(() => { mounted = true; });

	let prevS = $state(pad(seconds));
	let prevM = $state(pad(minutes));
	let prevH = $state(pad(hours));
	let prevD = $state(pad(days));

	let curS = $derived(pad(seconds));
	let curM = $derived(pad(minutes));
	let curH = $derived(pad(hours));
	let curD = $derived(pad(days));

	let animS = $state(false);
	let animM = $state(false);
	let animH = $state(false);
	let animD = $state(false);

	$effect(() => {
		const s = pad(seconds);
		if (mounted && s !== prevS) {
			animS = true;
			setTimeout(() => { prevS = s; animS = false; }, 600);
		}
	});
	$effect(() => {
		const m = pad(minutes);
		if (mounted && m !== prevM) {
			animM = true;
			setTimeout(() => { prevM = m; animM = false; }, 600);
		}
	});
	$effect(() => {
		const h = pad(hours);
		if (mounted && h !== prevH) {
			animH = true;
			setTimeout(() => { prevH = h; animH = false; }, 600);
		}
	});
	$effect(() => {
		const d = pad(days);
		if (mounted && d !== prevD) {
			animD = true;
			setTimeout(() => { prevD = d; animD = false; }, 600);
		}
	});

	const units = [
		{ label: 'Days' },
		{ label: 'Hrs' },
		{ label: 'Min' },
		{ label: 'Sec' },
	] as const;
</script>

<div class="fc-grid fc-{variant}">
	{#each units as unit, i}
		{@const cur = i === 0 ? curD : i === 1 ? curH : i === 2 ? curM : curS}
		{@const prev = i === 0 ? prevD : i === 1 ? prevH : i === 2 ? prevM : prevS}
		{@const anim = i === 0 ? animD : i === 1 ? animH : i === 2 ? animM : animS}
		{#if i > 0}<span class="fc-sep">:</span>{/if}
		<div class="fc-unit">
			<div class="fc-card-wrap">
				<!-- Top half: shows current value, static -->
				<div class="fc-half fc-top">
					<span>{cur}</span>
				</div>
				<!-- Bottom half: shows previous value, then flips to current -->
				<div class="fc-half fc-bottom">
					<span>{anim ? prev : cur}</span>
				</div>

				<!-- Animated top flap: folds down from previous to reveal current -->
				{#if anim}
					<div class="fc-flap fc-flap-top">
						<span>{prev}</span>
					</div>
					<div class="fc-flap fc-flap-bottom">
						<span>{cur}</span>
					</div>
				{/if}
			</div>
			<span class="fc-label">{unit.label}</span>
		</div>
	{/each}
</div>

<style>
	.fc-grid {
		display: flex; align-items: flex-start; justify-content: center;
		gap: 4px;
	}
	.fc-unit {
		display: flex; flex-direction: column; align-items: center; gap: 3px;
	}
	.fc-card-wrap {
		position: relative; width: 32px; height: 36px;
		border-radius: 6px; overflow: hidden;
	}

	/* Static halves */
	.fc-half {
		position: absolute; left: 0; right: 0;
		height: 50%; overflow: hidden;
		display: flex; align-items: center; justify-content: center;
		background: var(--bg-surface);
		border: 1px solid var(--border-subtle);
	}
	.fc-half span {
		font-family: 'Syne', sans-serif; font-size: 16px; font-weight: 800;
		color: var(--text-heading); line-height: 36px;
	}
	.fc-top {
		top: 0; border-radius: 6px 6px 0 0;
		border-bottom: none;
		background: linear-gradient(180deg, var(--bg-surface-hover), var(--bg-surface));
	}
	.fc-top span { transform: translateY(25%); }
	.fc-bottom {
		bottom: 0; border-radius: 0 0 6px 6px;
		border-top: none;
		background: linear-gradient(180deg, var(--bg-surface), var(--bg-surface-hover));
	}
	.fc-bottom span { transform: translateY(-25%); }

	/* The divider line */
	.fc-card-wrap::after {
		content: ''; position: absolute;
		left: 0; right: 0; top: 50%; height: 1px;
		background: var(--border); z-index: 5;
	}

	/* Animated flaps */
	.fc-flap {
		position: absolute; left: 0; right: 0;
		height: 50%; overflow: hidden;
		display: flex; align-items: center; justify-content: center;
		background: var(--bg-surface);
		backface-visibility: hidden; z-index: 10;
	}
	.fc-flap span {
		font-family: 'Syne', sans-serif; font-size: 16px; font-weight: 800;
		color: var(--text-heading); line-height: 36px;
	}

	/* Top flap folds down (shows old value, then disappears) */
	.fc-flap-top {
		top: 0; border-radius: 6px 6px 0 0;
		transform-origin: bottom center;
		animation: flapTop 0.3s ease-in forwards;
		background: linear-gradient(180deg, var(--bg-surface-hover), var(--bg-surface));
		border: 1px solid var(--border-subtle); border-bottom: none;
	}
	.fc-flap-top span { transform: translateY(25%); }

	/* Bottom flap unfolds (shows new value) */
	.fc-flap-bottom {
		bottom: 0; border-radius: 0 0 6px 6px;
		transform-origin: top center;
		animation: flapBottom 0.3s 0.3s ease-out forwards;
		transform: rotateX(90deg);
		background: linear-gradient(180deg, var(--bg-surface), var(--bg-surface-hover));
		border: 1px solid var(--border-subtle); border-top: none;
	}
	.fc-flap-bottom span { transform: translateY(-25%); }

	@keyframes flapTop {
		0% { transform: rotateX(0deg); }
		100% { transform: rotateX(-90deg); }
	}
	@keyframes flapBottom {
		0% { transform: rotateX(90deg); }
		100% { transform: rotateX(0deg); }
	}

	.fc-sep {
		font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 800;
		color: var(--text-dim); padding-top: 8px;
		animation: sepBlink 1s step-end infinite;
	}
	@keyframes sepBlink {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.3; }
	}

	.fc-label {
		font-family: 'Rajdhani', sans-serif; font-size: 8px;
		text-transform: uppercase; letter-spacing: 0.05em;
		color: var(--text-dim);
	}

	/* Cyan variant */
	.fc-cyan .fc-top,
	.fc-cyan .fc-flap-top {
		background: linear-gradient(180deg, rgba(0,210,255,0.08), var(--bg-surface));
		border-color: rgba(0,210,255,0.12);
	}
	.fc-cyan .fc-bottom,
	.fc-cyan .fc-flap-bottom {
		background: linear-gradient(180deg, var(--bg-surface), rgba(0,210,255,0.05));
		border-color: rgba(0,210,255,0.12);
	}
	.fc-cyan .fc-card-wrap::after { background: rgba(0,210,255,0.15); }

	/* Amber variant */
	.fc-amber .fc-half span,
	.fc-amber .fc-flap span { color: #f59e0b; }
	.fc-amber .fc-top,
	.fc-amber .fc-flap-top {
		background: linear-gradient(180deg, rgba(245,158,11,0.08), var(--bg-surface));
		border-color: rgba(245,158,11,0.15);
	}
	.fc-amber .fc-bottom,
	.fc-amber .fc-flap-bottom {
		background: linear-gradient(180deg, var(--bg-surface), rgba(245,158,11,0.05));
		border-color: rgba(245,158,11,0.15);
	}
	.fc-amber .fc-card-wrap::after { background: rgba(245,158,11,0.15); }
	.fc-amber .fc-sep { color: rgba(245,158,11,0.4); }
</style>
