<script lang="ts">
	/**
	 * PullToRefresh — wraps any scrollable area and fires `onRefresh` when
	 * the user drags down past a threshold while at scrollTop 0.
	 *
	 * Usage:
	 *   <PullToRefresh onRefresh={async () => { await refetch(); }}>
	 *     <div class="my-list">...</div>
	 *   </PullToRefresh>
	 *
	 * Behavior:
	 *   - Touch only — desktop wheel scroll never triggers.
	 *   - Threshold: 70px pull = commit refresh.
	 *   - Visual: a chevron at the top scales + rotates with pull progress,
	 *     swaps to a spinner during refresh.
	 *   - Reduced-motion users get a tighter visual but still functional.
	 *   - Disabled while another refresh is in flight.
	 */
	import { tap } from './haptics';

	let {
		onRefresh,
		threshold = 70,
		children,
	}: {
		onRefresh: () => Promise<void> | void;
		threshold?: number;
		children?: import('svelte').Snippet;
	} = $props();

	let pullDist = $state(0);
	let refreshing = $state(false);
	let active = $state(false);

	let startY = 0;
	let startScrollTop = 0;
	let containerEl: HTMLDivElement | undefined = $state();

	function findScrollParent(node: HTMLElement | null): HTMLElement {
		let el: HTMLElement | null = node;
		while (el && el !== document.body) {
			const s = getComputedStyle(el);
			if (/(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight) {
				return el;
			}
			el = el.parentElement;
		}
		return document.scrollingElement as HTMLElement || document.documentElement;
	}

	function onPointerDown(e: PointerEvent) {
		if (e.pointerType !== 'touch') return;
		if (refreshing) return;
		const scroller = findScrollParent(e.target as HTMLElement);
		startScrollTop = scroller.scrollTop;
		if (startScrollTop > 0) return;
		startY = e.clientY;
		active = true;
	}

	function onPointerMove(e: PointerEvent) {
		if (!active) return;
		const dy = e.clientY - startY;
		if (dy <= 0) {
			pullDist = 0;
			return;
		}
		// Resistance: feel like rubber-band beyond threshold.
		const resisted = dy < threshold ? dy : threshold + (dy - threshold) * 0.4;
		pullDist = resisted;
		// Don't preventDefault here — user may be flicking for a normal scroll
		// at scrollTop 0; only consume when we've crossed a small intent gate.
		if (pullDist > 14) e.preventDefault();
	}

	async function onPointerUp() {
		if (!active) return;
		active = false;
		if (refreshing) return;
		const committed = pullDist >= threshold;
		if (committed) {
			refreshing = true;
			tap();
			try {
				await onRefresh();
			} catch {}
			refreshing = false;
		}
		pullDist = 0;
	}

	let progress = $derived(Math.min(1, pullDist / threshold));
	let indicatorY = $derived(refreshing ? threshold * 0.6 : pullDist * 0.6);
	let chevronRot = $derived(progress * 180);
</script>

<div
	bind:this={containerEl}
	class="ptr-root"
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
>
	<div
		class="ptr-indicator"
		class:ptr-active={pullDist > 0 || refreshing}
		style="transform: translate(-50%, calc(-100% + {indicatorY}px))"
	>
		{#if refreshing}
			<svg class="ptr-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
				<path d="M21 12a9 9 0 1 1-6.2-8.5" stroke-linecap="round" />
			</svg>
		{:else}
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" style="transform: rotate({chevronRot}deg); opacity: {0.4 + 0.6 * progress}">
				<polyline points="6 9 12 15 18 9" />
			</svg>
		{/if}
	</div>

	<div
		class="ptr-content"
		style="transform: translateY({refreshing ? threshold * 0.6 : pullDist * 0.6}px); transition: {active ? 'none' : 'transform 220ms cubic-bezier(0.4, 0, 0.2, 1)'}"
	>
		{@render children?.()}
	</div>
</div>

<style>
	.ptr-root {
		position: relative;
		touch-action: pan-y;
	}
	.ptr-indicator {
		position: absolute;
		top: 0;
		left: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: 50%;
		background: var(--color-surface);
		border: 1px solid var(--color-line);
		color: var(--color-brand-cyan, #00d2ff);
		opacity: 0;
		transition: opacity 150ms ease;
		pointer-events: none;
		z-index: 1;
	}
	.ptr-active {
		opacity: 1;
	}
	.ptr-content {
		min-height: 1px;
	}
	.ptr-spin {
		animation: ptr-spin 0.8s linear infinite;
	}
	@keyframes ptr-spin {
		to { transform: rotate(360deg); }
	}
	@media (prefers-reduced-motion: reduce) {
		.ptr-content {
			transition: none !important;
		}
		.ptr-spin {
			animation-duration: 1.6s;
		}
	}
</style>
